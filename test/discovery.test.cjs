const assert = require("node:assert/strict");
const { join } = require("node:path");
const test = require("node:test");
const { createApp } = require("../dist/http/app");
const {
  finishRefresh,
  openDatabase,
  startRefresh,
} = require("../dist/storage/sqlite");
const { sourceCoverage } = require("../dist/transit/coverage");
const { importFeed } = require("../dist/transit/import-feed");

const archive = join(__dirname, "fixtures", "sample-gtfs.zip");
const board = "/api/v2/feeds/demo/stops/s1/departures";

async function setup(t) {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  await importFeed(db, "demo", archive, undefined);
  const app = createApp(db);
  return {
    db,
    app,
    async get(path, status = 200) {
      const response = await app.request(path);
      assert.equal(response.status, status);
      return response.json();
    },
  };
}

test("finds nearby stops across feeds, ordered by distance with stable pagination", async (t) => {
  const { db, get } = await setup(t);
  await importFeed(db, "other", archive, undefined);
  db.exec(
    `UPDATE stops SET record = json_set(record, '$.location_type', 1) WHERE feed_key = 'other' AND stop_id = 's2'`,
  );
  const path = "/api/v2/nearby-stops?lat=38.71&lon=-9.15&radius=2";
  const first = await get(path + "&limit=1");
  assert.equal(first.data[0].feedKey, "demo");
  assert.equal(first.data[0].distanceMeters, 0);
  assert.equal(first.pagination.nextOffset, 1);
  const rest = await get(path + "&offset=1");
  assert.deepEqual(
    rest.data.map(({ feedKey, id }) => [feedKey, id]),
    [
      ["other", "s1"],
      ["demo", "s2"],
    ],
  );
  assert.ok(rest.data[1].distanceMeters > 1000);
  await get("/api/v2/nearby-stops?lat=38.71", 400);
  await get("/api/v2/nearby-stops?lat=38.71&lon=-9.15&radius=26", 400);
});

test("serves boardable departures across midnight using the original service day", async (t) => {
  const { db, get } = await setup(t);
  const from = "?from=2026-11-21T00:50:00Z";
  const response = await get(board + from);
  const departure = response.data[0];
  assert.equal(departure.departureAt, "2026-11-21T01:01:00+00:00");
  assert.equal(departure.serviceDate, "2026-11-20");
  assert.equal(departure.routeShortName, "1");
  assert.equal(departure.headsign, "Second");
  assert.ok(response.feed.importedAt);
  assert.deepEqual((await get(board + from + "&minutes=11")).data, []);
  await get(board + "?from=2026-02-30T12:00:00Z", 400);
  await get(board + "?from=2026-11-21T00:50:00", 400);
  await get(board + "?offset=1", 400);
  await get("/api/v2/feeds/demo/stops/missing/departures", 404);
  db.exec(
    `UPDATE stop_times SET record = json_set(record, '$.pickup_type', 1) WHERE stop_id = 's1'`,
  );
  assert.deepEqual((await get(board + from)).data, []);
});

test("shifts exact and headway schedules by the travel time from the first stop", async (t) => {
  const { db, get } = await setup(t);
  const insert = db.prepare("INSERT INTO frequencies VALUES (?, ?, ?, ?)");
  for (const [start, end, exact] of [
    ["23:00:00", "23:30:00", 1],
    ["24:00:00", "26:00:00", 0],
  ]) {
    insert.run(
      "demo",
      "t1",
      start,
      JSON.stringify({
        start_time: start,
        end_time: end,
        headway_secs: 600,
        exact_times: exact,
      }),
    );
  }
  const second = "/api/v2/feeds/demo/stops/s2/departures";
  const response = await get(second + "?from=2026-11-20T23:02:00Z&minutes=120");
  assert.deepEqual(
    response.data.map(({ departureAt }) => departureAt),
    ["2026-11-20T23:11:00+00:00", "2026-11-20T23:21:00+00:00", null],
  );
  const [window] = (await get(second + "?from=2026-11-21T00:20:00Z&limit=1"))
    .data;
  assert.equal(window.kind, "headway");
  assert.equal(window.windowStartsAt, "2026-11-21T00:01:00+00:00");
  assert.equal(window.windowEndsAt, "2026-11-21T02:01:00+00:00");
  assert.equal(window.headwaySeconds, 600);
});

test("resolves an overnight departure across the Lisbon spring DST change", async (t) => {
  const { db, get } = await setup(t);
  db.exec(
    `UPDATE calendar_dates SET date = '20260328' WHERE feed_key = 'demo'`,
  );
  const path = board + "?from=2026-03-29T00:55:00Z";
  const [departure] = (await get(path)).data;
  assert.equal(departure.serviceDate, "2026-03-28");
  assert.equal(departure.departureAt, "2026-03-29T02:01:00+01:00");
});

test("surfaces missing snapshots, failed refreshes and expiring service in coverage", async (t) => {
  const { db, get } = await setup(t);
  await importFeed(db, "carris", archive, undefined);
  const attempt = startRefresh(db, "carris");
  finishRefresh(db, "carris", attempt, "failed", "Source unavailable");
  const rows = sourceCoverage(db, new Date("2026-11-20T12:00:00Z"));
  assert.deepEqual(rows.find(({ key }) => key === "carris").alerts, [
    "refresh_failed",
    "schedule_expiring",
  ]);
  const status = await get("/api/v2/source-health", 503);
  assert.equal(status.status, "attention");
  assert.deepEqual(status.data.find(({ key }) => key === "cp").alerts, [
    "missing_snapshot",
  ]);
  const sources = await get("/api/v2/sources");
  const carris = sources.data.find(({ key }) => key === "carris");
  assert.equal(carris.region, "Lisbon");
  assert.equal(carris.mode, "Bus and tram");
});
