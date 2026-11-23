const assert = require("node:assert/strict");
const { join } = require("node:path");
const test = require("node:test");
const { createApp } = require("../dist/http/app");
const { openDatabase } = require("../dist/storage/sqlite");
const { importFeed } = require("../dist/transit/import-feed");

const archive = join(__dirname, "fixtures", "demo-gtfs.zip");

async function setup(t, feedKey = "demo") {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  await importFeed(db, feedKey, archive, undefined);
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

test("lists every route calling at a stop, not just active departures", async (t) => {
  const { get } = await setup(t);
  const first = await get("/api/v2/feeds/demo/stops/s1/routes");
  assert.deepEqual(
    first.data.map(({ id, shortName }) => [id, shortName]),
    [
      ["r1", "1"],
      ["r2", "2"],
    ],
  );
  assert.equal(first.data[0].type, 3);
  // Destinations distinguish routes that share a public line name.
  assert.deepEqual(first.data[0].headsigns, ["First", "Second"]);
  assert.deepEqual(first.data[1].headsigns, ["First", "Fourth"]);
  const fourth = await get("/api/v2/feeds/demo/stops/s4/routes");
  assert.deepEqual(
    fourth.data.map(({ id }) => id),
    ["r2"],
  );
  assert.deepEqual(fourth.data[0].headsigns, ["First", "Fourth"]);
  const paged = await get("/api/v2/feeds/demo/stops/s1/routes?limit=1");
  assert.deepEqual(
    paged.data.map(({ id }) => id),
    ["r1"],
  );
  assert.equal(paged.pagination.nextOffset, 1);
  await get("/api/v2/feeds/demo/stops/missing/routes", 404);
  await get("/api/v2/feeds/missing/stops/s1/routes", 404);
  await get("/api/v2/feeds/demo/stops/s1/routes?routeId=r1", 400);
});

test("route patterns expose both directions with ordered stops, times and geometry", async (t) => {
  const { get } = await setup(t);
  const { data } = await get("/api/v2/feeds/demo/routes/r2/patterns");
  assert.equal(data.feedKey, "demo");
  assert.equal(data.routeId, "r2");
  assert.equal(data.geometryUnavailable, false);
  assert.equal(data.patternsTruncated, false);
  assert.equal(data.patterns.length, 2);

  const [outbound, inbound] = data.patterns;
  assert.equal(outbound.direction, 0);
  assert.equal(outbound.headsign, "Fourth");
  assert.equal(outbound.tripId, "t3");
  assert.deepEqual(
    outbound.stops.map(({ id, name, sequence }) => [id, name, sequence]),
    [
      ["s1", "First", 1],
      ["s3", "Third", 2],
      ["s4", "Fourth", 3],
    ],
  );
  assert.equal(outbound.stops[0].latitude, 38.71);
  assert.equal(outbound.stops[0].departureTime, "25:10:00");
  assert.equal(outbound.stops[2].departureTime, "25:14:00");
  assert.ok(outbound.coordinates.length >= 3);

  assert.equal(inbound.direction, 1);
  assert.equal(inbound.headsign, "First");
  assert.deepEqual(
    inbound.stops.map(({ id }) => id),
    ["s4", "s3", "s1"],
  );

  // Pattern IDs match the fleet grouping so live vehicles join the same way.
  const fleet = await get("/api/v2/feeds/demo/routes/r2/fleet");
  const fleetIds = new Set(fleet.data.patterns.map(({ id }) => id));
  for (const pattern of data.patterns) assert.ok(fleetIds.has(pattern.id));

  await get("/api/v2/feeds/demo/routes/missing/patterns", 404);
  await get("/api/v2/feeds/missing/routes/r2/patterns", 404);
});

test("filters departures by route for a single route's daily window", async (t) => {
  const { get } = await setup(t);
  const path =
    "/api/v2/feeds/demo/stops/s1/departures?from=2026-11-21T00:50:00Z";
  const all = await get(path);
  assert.deepEqual(
    [...new Set(all.data.map(({ routeId }) => routeId))],
    ["r1", "r2"],
  );
  const r1 = await get(path + "&routeId=r1");
  assert.ok(r1.data.length > 0);
  assert.ok(r1.data.every(({ routeId }) => routeId === "r1"));
  const missing = await get(path + "&routeId=missing");
  assert.deepEqual(missing.data, []);
  await get(path + "&routeId=", 400);
});

test("the representative trip is the fullest variant and stops stay ordered", async (t) => {
  const { db, get } = await setup(t);
  // Add a short-turn trip on the same variant (same shape/direction/headsign).
  db.exec(`
    INSERT INTO trips VALUES ('demo', 't3-short', 'r2', 'weekday', 0, 'shape3',
      '{"route_id":"r2","service_id":"weekday","trip_id":"t3-short","direction_id":0,"trip_headsign":"Fourth","shape_id":"shape3"}');
    INSERT INTO stop_times VALUES ('demo', 't3-short', 1, 's1',
      '{"trip_id":"t3-short","stop_id":"s1","stop_sequence":1,"departure_time":"25:10:00"}');
  `);
  const { data } = await get("/api/v2/feeds/demo/routes/r2/patterns");
  const outbound = data.patterns.find(({ direction }) => direction === 0);
  assert.equal(outbound.tripId, "t3");
  assert.equal(outbound.stops.length, 3);
});

test("searches stops by name and code across feeds, boardable stops only", async (t) => {
  const { db, get } = await setup(t);
  await importFeed(db, "other", archive, undefined);
  const found = await get("/api/v2/stops?q=First");
  assert.deepEqual(
    found.data.map(({ feedKey, id, name }) => [feedKey, id, name]),
    [
      ["demo", "s1", "First"],
      ["other", "s1", "First"],
    ],
  );
  // Case-insensitive substring match.
  assert.equal((await get("/api/v2/stops?q=fir")).data.length, 2);
  assert.equal((await get("/api/v2/stops?q=IRST")).data.length, 2);
  // Code search.
  db.exec(
    `UPDATE stops SET record = json_set(record, '$.stop_code', '12345') WHERE feed_key = 'demo' AND stop_id = 's3'`,
  );
  assert.deepEqual(
    (await get("/api/v2/stops?q=12345")).data.map(({ id }) => id),
    ["s3"],
  );
  // Non-boardable stops (location_type 1) are excluded.
  db.exec(
    `UPDATE stops SET record = json_set(record, '$.location_type', 1) WHERE feed_key = 'other' AND stop_id = 's2'`,
  );
  assert.deepEqual(
    (await get("/api/v2/stops?q=Second")).data.map(({ feedKey }) => feedKey),
    ["demo"],
  );
  // Validation and pagination.
  await get("/api/v2/stops?q=x", 400);
  await get("/api/v2/stops", 400);
  const paged = await get("/api/v2/stops?q=First&limit=1");
  assert.equal(paged.data.length, 1);
  assert.equal(paged.pagination.nextOffset, 1);
  // LIKE wildcards in the query are treated literally, not as patterns.
  assert.deepEqual((await get("/api/v2/stops?q=%25%25")).data, []);
});

test("the enriched demo still shows First at 01:01", async (t) => {
  const { get } = await setup(t);
  const response = await get(
    "/api/v2/feeds/demo/stops/s1/departures?from=2026-11-21T00:50:00Z",
  );
  const departure = response.data[0];
  assert.equal(departure.departureAt, "2026-11-21T01:01:00+00:00");
  assert.equal(departure.serviceDate, "2026-11-20");
  assert.equal(departure.routeShortName, "1");
});

test("the OpenAPI contract documents the explorer endpoints", async (t) => {
  const { app } = await setup(t);
  const response = await app.request("/openapi.json");
  assert.equal(response.status, 200);
  const spec = await response.json();
  for (const path of [
    "/stops",
    "/feeds/{feedKey}/stops/{stopId}/routes",
    "/feeds/{feedKey}/routes/{routeId}/patterns",
  ]) {
    assert.ok(spec.paths[path], `missing path ${path}`);
  }
  assert.ok(spec.components.schemas.RoutePatterns);
});

test("summarizes the selected pattern across service dates", async (t) => {
  const { db, get } = await setup(t);
  db.prepare(
    "INSERT INTO calendar_dates (feed_key, service_id, date, record) VALUES (?, ?, ?, ?)",
  ).run("demo", "weekday", "20261127", JSON.stringify({ exception_type: 1 }));
  // The competing variant starts at the same stop five minutes later.
  db.prepare(
    "UPDATE stop_times SET stop_id = 's1' WHERE trip_id = 't2' AND stop_sequence = 1",
  ).run();
  const base = "/api/v2/feeds/demo/routes/r1";
  const {
    data: { patterns },
  } = await get(base + "/patterns");
  const path =
    base + "/pattern-schedule?patternId=" + encodeURIComponent(patterns[0].id);
  const between = await get(path + "&from=2026-11-21T01:03:00Z");
  assert.equal(between.data.last.departureAt, "2026-11-21T01:01:00+00:00");
  assert.equal(between.data.next.tripId, "t1");
  assert.equal(between.data.next.serviceDate, "2026-11-27");
  const { data } = await get(path + "&from=2026-11-21T02:00:00Z");
  assert.equal(data.first.departureAt, "2026-11-21T01:01:00+00:00");
  assert.equal(data.last.tripId, "t1");
  assert.equal(data.next.departureAt, "2026-11-28T01:01:00+00:00");
  await get(base + "/pattern-schedule?patternId=missing", 404);
  await get(path + "&from=invalid", 400);
});
