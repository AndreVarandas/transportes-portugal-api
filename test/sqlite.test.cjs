const assert = require("node:assert/strict");
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");
const { createApp } = require("../dist/http/app");
const {
  currentDigest,
  openDatabase,
  replaceFeed,
} = require("../dist/storage/sqlite");
const { importFeed } = require("../dist/transit/import-feed");

const archive = join(__dirname, "fixtures", "sample-gtfs.zip");

test("imports a feed, scopes IDs by feed, and serves schedule queries", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const imported = await importFeed(db, "test", archive, undefined);
  assert.equal(imported.changed, true);
  assert.equal(imported.counts["stop-times"], 2);
  assert.deepEqual(
    await importFeed(db, "test", archive, currentDigest(db, "test")),
    { changed: false },
  );
  await importFeed(db, "other", archive, undefined);

  const app = createApp(db);
  async function get(path) {
    const response = await app.request("/api/v2/feeds" + path);
    assert.equal(response.status, 200);
    return (await response.json()).data;
  }

  assert.deepEqual(
    (await get("?limit=1&offset=1")).map(({ key }) => key),
    ["test"],
  );
  for (const key of ["test", "other"]) {
    assert.equal((await get(`/${key}/routes/r1`)).id, "r1");
    assert.equal((await get(`/${key}/routes/r1/trips`))[0].id, "t1");
    assert.equal((await get(`/${key}/stops?routeId=r1`)).length, 2);
    assert.equal(
      (await get(`/${key}/shapes?routeId=r1&limit=1`))[0].points.length,
      2,
    );
    assert.equal(
      (await get(`/${key}/calendar-dates?date=2026-11-20`)).length,
      1,
    );
  }
});

test("keeps the old snapshot visible during a write and rolls back on failure", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "transit-test-"));
  const path = join(directory, "transit.sqlite");
  const writer = openDatabase(path);
  const reader = openDatabase(path);
  t.after(() => {
    reader.close();
    writer.close();
    rmSync(directory, { recursive: true, force: true });
  });

  await importFeed(writer, "test", archive, undefined);
  const digest = currentDigest(writer, "test");
  const routes = () =>
    reader.prepare("SELECT count(*) AS count FROM routes").get().count;
  await assert.rejects(
    replaceFeed(writer, "test", "next", digest, async () => {
      assert.equal(
        writer.prepare("SELECT count(*) AS count FROM routes").get().count,
        0,
      );
      assert.equal(routes(), 1);
      assert.equal(currentDigest(reader, "test"), digest);
      throw new Error("refresh failed");
    }),
    /refresh failed/,
  );
  assert.equal(routes(), 1);

  const invalidZip = join(directory, "invalid.zip");
  writeFileSync(invalidZip, "not an archive");
  await assert.rejects(importFeed(writer, "test", invalidZip, digest));
  assert.equal(routes(), 1);
  assert.equal(currentDigest(reader, "test"), digest);
  await assert.rejects(
    replaceFeed(writer, "test", "next", undefined, async () => ({})),
    /Another refresh/,
  );
});

test("rejects an expired remote snapshot and keeps local archive imports available", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  await assert.rejects(
    importFeed(db, "test", archive, undefined, "20261121"),
    /latest: 20261120/,
  );
  assert.equal(currentDigest(db, "test"), undefined);

  await importFeed(db, "test", archive, undefined);
  const digest = currentDigest(db, "test");
  await assert.rejects(
    importFeed(db, "test", archive, digest, "20261121"),
    /latest: 20261120/,
  );
  assert.equal(currentDigest(db, "test"), digest);
});

test("reports refresh outcomes and preserves coverage after a failed attempt", async (t) => {
  const { spawnSync } = require("node:child_process");
  const { listImports } = require("../dist/storage/sqlite");
  const directory = mkdtempSync(join(tmpdir(), "transit-refresh-test-"));
  const path = join(directory, "transit.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runImport = (source) =>
    spawnSync(
      process.execPath,
      [join(__dirname, "../dist/transit/import-cli.js"), "test", source],
      {
        env: { ...process.env, SQLITE_PATH: path },
        encoding: "utf8",
      },
    );

  const first = runImport(archive);
  assert.equal(first.status, 0, first.stderr);
  const db = openDatabase(path);
  t.after(() => db.close());
  const status = () => listImports(db, "20261120")[0];
  const initial = status();
  assert.equal(initial.refresh_status, "imported");
  assert.equal(initial.schedule_status, "in_range");
  assert.equal(initial.service_start_date, "20261120");
  assert.equal(initial.service_end_date, "20261120");

  const identical = runImport(archive);
  assert.equal(identical.status, 0, identical.stderr);
  assert.equal(status().refresh_status, "unchanged");
  const failure = runImport(join(directory, "missing.zip"));
  assert.equal(failure.status, 1);
  assert.equal(status().refresh_status, "failed");
  assert.equal(status().imported_at, initial.imported_at);
  assert.equal(status().service_end_date, initial.service_end_date);
  assert.match(status().refresh_error, /Local archive import failed/);
  assert.equal(listImports(db, "20261121")[0].schedule_status, "expired");
  assert.equal(listImports(db, "20261119")[0].schedule_status, "upcoming");

  const response = await createApp(db).request("/api/v2/feeds");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data[0].latestRefresh.status, "failed");
});

test("serves normalized read-only v2 resources and removes legacy routes", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  await importFeed(db, "test", archive, undefined);
  const app = createApp(db);
  const base = "/api/v2/feeds/test";
  async function get(path, status = 200) {
    const response = await app.request(path);
    assert.equal(response.status, status);
    return response.json();
  }

  const feed = await get(base);
  assert.equal(feed.data.key, "test");
  assert.equal(feed.data.schedule.startDate, "2026-11-20");
  const routes = await get(base + "/routes?agencyId=a1");
  assert.equal(routes.data[0].id, "r1");
  assert.equal(routes.data[0].shortName, "1");
  assert.equal(routes.data[0].longName, null);
  assert.equal(routes.data[0].route_id, undefined);
  assert.equal((await get(base + "/routes/r1")).data.id, "r1");
  const trips = await get(base + "/routes/r1/trips?directionId=0");
  assert.equal(trips.data[0].id, "t1");
  const times = await get(base + "/trips/t1/stop-times?limit=1");
  assert.equal(times.data[0].arrivalTime, "25:01:00");
  assert.equal(times.pagination.nextOffset, 1);
  const last = await get(base + "/trips/t1/stop-times?limit=1&offset=1");
  assert.equal(last.data[0].stopId, "s2");
  assert.equal(last.pagination.nextOffset, null);
  assert.equal(
    (await get(base + "/stops/s1/stop-times?tripId=t1")).data.length,
    1,
  );
  assert.equal(
    (await get(base + "/calendar-dates?date=2026-11-20")).data[0].date,
    "2026-11-20",
  );
  assert.equal((await get(base + "/shapes/shape1")).data.points.length, 2);
  assert.equal(
    (await get(base + "/trips/unknown/stop-times", 404)).error.code,
    "not_found",
  );
  assert.equal(
    (await get("/api/v2/feeds/missing/routes", 404)).error.code,
    "not_found",
  );
  assert.equal(
    (await get(base + "/calendar-dates?date=2026-02-30", 400)).error.code,
    "invalid_query",
  );
  assert.equal(
    (await get(base + "/routes?limit=1&limit=2", 400)).error.code,
    "invalid_query",
  );
  const write = await app.request(base + "/routes", { method: "POST" });
  assert.equal(write.status, 405);
  assert.equal(write.headers.get("Allow"), "GET, HEAD");
  assert.equal((await app.request("/api/v1/feeds")).status, 404);
  assert.equal(
    (await app.request("/api/v1/routes", { method: "POST" })).status,
    404,
  );
});

test("discovers configured sources before setup and reports failed refreshes", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const { startRefresh, finishRefresh } = require("../dist/storage/sqlite");
  const app = createApp(db);
  const url = "/api/v2/sources?limit=1";
  const initial = await (await app.request(url)).json();
  assert.equal(initial.data[0].key, "carris");
  assert.equal(initial.data[0].feed, null);
  assert.equal(initial.pagination.nextOffset, 1);

  const attempt = startRefresh(db, "carris");
  finishRefresh(db, "carris", attempt, "failed", "Source offline.");
  const refreshed = await (await app.request(url)).json();
  assert.equal(refreshed.data[0].feed.importedAt, null);
  assert.equal(refreshed.data[0].feed.latestRefresh.status, "failed");
});

test("filters trips and stop times by weekly service and date exceptions", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  await importFeed(db, "test", archive, undefined);
  const app = createApp(db);
  const exceptionOnly = await app.request(
    "/api/v2/feeds/test/stops/s1/stop-times?serviceDate=2026-11-20",
  );
  assert.equal((await exceptionOnly.json()).data[0].arrivalTime, "25:01:00");
  db.prepare("INSERT INTO calendars VALUES (?, ?, ?)").run(
    "test",
    "weekday",
    JSON.stringify({
      start_date: "20261118",
      end_date: "20261130",
      monday: 1,
      friday: 1,
    }),
  );
  db.prepare("INSERT INTO calendar_dates VALUES (?, ?, ?, ?)").run(
    "test",
    "weekday",
    "20261127",
    '{"exception_type":2}',
  );
  db.prepare("INSERT INTO calendar_dates VALUES (?, ?, ?, ?)").run(
    "test",
    "weekday",
    "20261121",
    '{"exception_type":1}',
  );

  for (const path of ["trips", "routes/r1/trips", "stops/s1/stop-times"]) {
    const url = "/api/v2/feeds/test/" + path + "?serviceDate=";
    for (const [date, expected] of [
      ["2026-11-23", 1],
      ["2026-11-21", 1],
      ["2026-11-22", 0],
      ["2026-11-27", 0],
      ["2026-12-04", 0],
    ]) {
      const response = await app.request(url + date);
      assert.equal(response.status, 200);
      assert.equal(
        (await response.json()).data.length,
        expected,
        path + " " + date,
      );
    }
    assert.equal((await app.request(url + "2026-02-30")).status, 400);
  }
});

test("serves interactive documentation with a spec covering all v2 GET routes", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const app = createApp(db);

  const home = await app.request("/");
  assert.equal(home.headers.get("location"), "/docs");
  const docs = await app.request("/docs");
  assert.equal(docs.status, 200);
  assert.match(await docs.text(), /id="swagger-ui"/);

  for (const [file, type] of [
    ["swagger-ui-bundle.js", "javascript"],
    ["swagger-ui.css", "text/css"],
    ["init.js", "javascript"],
  ]) {
    const asset = await app.request("/docs/" + file);
    assert.equal(asset.status, 200);
    assert.ok(asset.headers.get("content-type").includes(type));
    assert.ok((await asset.arrayBuffer()).byteLength > 0);
  }

  const response = await app.request("/openapi.json");
  const spec = await response.json();
  assert.equal(response.status, 200);
  assert.equal(spec.openapi, "3.1.0");
  const routePaths = app.routes
    .filter(
      (route) => route.method === "GET" && route.path.startsWith("/api/v2/"),
    )
    .map((route) => route.path.slice("/api/v2".length).replace(/:\w+/g, "{}"));
  const specPaths = Object.keys(spec.paths).map((path) =>
    path.replace(/\{\w+\}/g, "{}"),
  );
  assert.deepEqual(specPaths.sort(), routePaths.sort());
});
