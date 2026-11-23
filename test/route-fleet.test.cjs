const assert = require("node:assert/strict");
const { join } = require("node:path");
const test = require("node:test");
const { transit_realtime: rt } = require("gtfs-realtime-bindings");
const { createApp } = require("../dist/http/app");
const { openDatabase } = require("../dist/storage/sqlite");
const { importFeed } = require("../dist/transit/import-feed");
const { createRouteFleet } = require("../dist/transit/route-fleet");

const archive = join(__dirname, "fixtures", "sample-gtfs.zip");
const now = Date.parse("2026-11-21T12:00:00Z");

async function setup(t, feedKey) {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  await importFeed(db, feedKey, archive, undefined);
  return db;
}

function tripPattern(db, feedKey, tripId) {
  const trip = db
    .prepare(
      `SELECT shape_id, direction_id,
        COALESCE(json_extract(record, '$.trip_headsign'), '') AS headsign
        FROM trips WHERE feed_key = ? AND trip_id = ?`,
    )
    .get(feedKey, tripId);
  return JSON.stringify([trip.shape_id, trip.direction_id, trip.headsign]);
}

function carrisSnapshot(entities, incrementality = 0) {
  const bytes = rt.FeedMessage.encode({
    header: { gtfsRealtimeVersion: "2.0", incrementality },
    entity: entities,
  }).finish();
  return new Response(bytes);
}

const carrisVehicle = {
  id: "e1",
  vehicle: {
    vehicle: { id: "bus-1" },
    trip: { tripId: "t1", routeId: "r1", directionId: 0 },
    position: { latitude: 38.7, longitude: -9.1, bearing: 90 },
    timestamp: now / 1000,
  },
};

test("route-only feeds return planned geometry without contacting any upstream", async (t) => {
  const db = await setup(t, "demo");
  const fleet = createRouteFleet(
    db,
    async () => {
      throw new Error("No upstream expected for a route-only feed");
    },
    () => now,
  );
  const result = await fleet("demo", "r1");
  assert.equal(result.feedKey, "demo");
  assert.equal(result.routeId, "r1");
  assert.equal(result.liveSupported, false);
  assert.equal(result.synthetic, true);
  assert.equal(result.vehiclesUnavailable, false);
  assert.deepEqual(result.vehicles, []);
  assert.equal(result.geometryUnavailable, false);
  assert.ok(result.patterns.length >= 1);
  assert.ok(result.patterns[0].coordinates.length >= 2);
  assert.equal(result.freshForMs, 90_000);
  assert.equal(await fleet("demo", "missing"), null);
});

test("non-live operators keep their provider name and are not synthetic", async (t) => {
  const db = await setup(t, "metro-porto");
  const fleet = createRouteFleet(
    db,
    async () => new Response(null, { status: 500 }),
    () => now,
  );
  const result = await fleet("metro-porto", "r1");
  assert.equal(result.provider, "Metro do Porto");
  assert.equal(result.attribution, "Metro do Porto");
  assert.equal(result.liveSupported, false);
  assert.equal(result.synthetic, false);
  assert.deepEqual(result.vehicles, []);
});

test("carris observations join imported trips and fall back to the GTFS route ID", async (t) => {
  const db = await setup(t, "carris");
  const fleet = createRouteFleet(
    db,
    async () =>
      carrisSnapshot([
        carrisVehicle,
        {
          id: "e2",
          vehicle: {
            vehicle: { id: "bus-2" },
            trip: { tripId: "unknown-trip", routeId: "r1" },
            position: { latitude: 38.71, longitude: -9.11 },
            timestamp: now / 1000,
          },
        },
        {
          id: "e3",
          vehicle: {
            vehicle: { id: "bus-3" },
            trip: { routeId: "r9" },
            position: { latitude: 38.72, longitude: -9.12 },
            timestamp: now / 1000,
          },
        },
      ]),
    () => now,
  );
  const result = await fleet("carris", "r1");
  assert.equal(result.liveSupported, true);
  assert.equal(result.synthetic, false);
  assert.equal(result.provider, "Carris");
  assert.equal(result.attribution, "Carris");
  assert.equal(result.lineId, "1");
  assert.equal(result.vehiclesUnavailable, false);
  assert.deepEqual(
    result.vehicles.map((v) => v.id),
    ["bus-1", "bus-2"],
  );
  const joined = result.vehicles[0];
  assert.equal(joined.patternId, tripPattern(db, "carris", "t1"));
  assert.equal(joined.bearing, 90);
  assert.equal(joined.observedAt, now);
  assert.equal(result.vehicles[1].patternId, "");
  assert.ok(result.patterns.some((p) => p.id === joined.patternId));
});

test("stcp observations require an exact trip join and keep their attribution", async (t) => {
  const db = await setup(t, "stcp");
  const entity = (annotations, id) => ({
    dataProvider: { value: "STCP" },
    annotations: { value: annotations },
    location: { value: { coordinates: [-9.1, 38.7] } },
    fleetVehicleId: { value: id },
    bearing: { value: 180 },
    observationDateTime: { value: new Date(now).toISOString() },
  });
  const fleet = createRouteFleet(
    db,
    async () =>
      Response.json([
        entity(
          ["stcp:sentido:0", "stcp:nr_viagem:t1", "stcp:route:1"],
          "stcp-1",
        ),
        entity(["stcp:route:1"], "stcp-2"),
        {
          ...entity(["stcp:nr_viagem:t1"], "stcp-3"),
          dataProvider: { value: "OTHER" },
        },
      ]),
    () => now,
  );
  const result = await fleet("stcp", "r1");
  assert.equal(result.liveSupported, true);
  assert.equal(result.attribution, "STCP · Porto Digital");
  assert.equal(result.vehicles.length, 1);
  const vehicle = result.vehicles[0];
  assert.equal(vehicle.id, "stcp-1");
  assert.equal(vehicle.latitude, 38.7);
  assert.equal(vehicle.longitude, -9.1);
  assert.equal(vehicle.bearing, 180);
  assert.equal(vehicle.patternId, tripPattern(db, "stcp", "t1"));
});

test("stcp falls back to the reported route when trip IDs differ from GTFS", async (t) => {
  const db = await setup(t, "stcp");
  const entity = (annotations, id) => ({
    dataProvider: { value: "STCP" },
    annotations: { value: annotations },
    location: { value: { coordinates: [-8.6, 41.15] } },
    fleetVehicleId: { value: id },
    observationDateTime: { value: new Date(now).toISOString() },
  });
  const fleet = createRouteFleet(
    db,
    async () =>
      Response.json([
        // Live trip IDs carry schedule variants that do not exist in the GTFS feed.
        entity(
          [
            "stcp:sentido:1",
            "stcp:nr_viagem:r1_0_1|338|D3|T2|N11",
            "stcp:route:r1",
          ],
          "stcp-9",
        ),
        entity(["stcp:sentido:0", "stcp:route:r2"], "stcp-other-route"),
      ]),
    () => now,
  );
  const result = await fleet("stcp", "r1");
  assert.equal(result.vehicles.length, 1);
  assert.equal(result.vehicles[0].id, "stcp-9");
  assert.equal(result.vehicles[0].patternId, "");
  assert.equal(result.vehicles[0].direction, 1);
  assert.equal(result.vehicles[0].latitude, 41.15);
});

test("a failed or differential vehicle feed is unavailable, not an empty fleet", async (t) => {
  const db = await setup(t, "carris");
  for (const response of [
    new Response(null, { status: 503 }),
    carrisSnapshot([carrisVehicle], 1),
  ]) {
    const fleet = createRouteFleet(
      db,
      async () => response,
      () => now,
    );
    const result = await fleet("carris", "r1");
    assert.equal(result.vehiclesUnavailable, true);
    assert.deepEqual(result.vehicles, []);
    assert.equal(result.liveSupported, true);
    assert.ok(result.patterns.length >= 1);
  }
});

test("geometry cache follows the feed import, not the clock", async (t) => {
  const db = await setup(t, "demo");
  const fleet = createRouteFleet(
    db,
    async () => new Response(null, { status: 500 }),
    () => now,
  );
  const first = await fleet("demo", "r1");
  db.exec(
    `UPDATE shapes SET record = json_set(record, '$.shape_pt_lat', 38.9)
      WHERE feed_key = 'demo' AND shape_id = 'shape1'`,
  );
  const cached = await fleet("demo", "r1");
  assert.deepEqual(cached.patterns, first.patterns);
  db.exec(
    `UPDATE feeds SET imported_at = '2026-11-21T12:05:00Z' WHERE feed_key = 'demo'`,
  );
  const refreshed = await fleet("demo", "r1");
  assert.ok(refreshed.patterns[0].coordinates.every(([lat]) => lat === 38.9));
});

test("carris-metropolitana routes delegate to the live line service", async (t) => {
  const db = await setup(t, "carris-metropolitana");
  db.exec(
    `UPDATE routes SET record = json_set(record, '$.route_short_name', '1708')
      WHERE feed_key = 'carris-metropolitana' AND route_id = 'r1'`,
  );
  const fleet = createRouteFleet(
    db,
    async (url) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/lines"))
        return Response.json([
          { id: "1708", long_name: "Circular", pattern_ids: ["1708_0_3"] },
        ]);
      if (path.endsWith("/vehicles"))
        return Response.json([
          {
            id: "bus",
            line_id: "1708",
            pattern_id: "[version]1708_0_3",
            lat: 38.7,
            lon: -9.1,
            timestamp: now,
            direction_id: 0,
          },
        ]);
      if (path.includes("/patterns/"))
        return Response.json([
          {
            id: "1708_0_3",
            valid_on: ["20261121"],
            headsign: "Casal Mira",
            direction_id: 0,
            shape_id: "current",
          },
        ]);
      return Response.json({
        geojson: {
          geometry: {
            coordinates: [
              [-9.1, 38.7],
              [-9.2, 38.8],
            ],
          },
        },
      });
    },
    () => now,
  );
  const result = await fleet("carris-metropolitana", "r1");
  assert.equal(result.feedKey, "carris-metropolitana");
  assert.equal(result.routeId, "r1");
  assert.equal(result.lineId, "1708");
  assert.equal(result.liveSupported, true);
  assert.equal(result.synthetic, false);
  assert.equal(result.attribution, "Carris Metropolitana");
  assert.equal(result.vehicles.length, 1);
  assert.equal(result.patterns[0].headsign, "Casal Mira");
});

test("carris-metropolitana lines outside the four-digit catalogue stay route-only", async (t) => {
  const db = await setup(t, "carris-metropolitana");
  db.exec(
    `UPDATE routes SET record = json_set(record, '$.route_short_name', 'X1')
      WHERE feed_key = 'carris-metropolitana' AND route_id = 'r1'`,
  );
  const fleet = createRouteFleet(
    db,
    async () => {
      throw new Error("No live catalogue expected for a non-public line");
    },
    () => now,
  );
  const result = await fleet("carris-metropolitana", "r1");
  assert.equal(result.liveSupported, false);
  assert.deepEqual(result.vehicles, []);
  assert.equal(result.attribution, "Carris Metropolitana");
  assert.ok(result.patterns.length >= 1);
});

test("the HTTP endpoint serves fleet snapshots, 404s, and source capabilities", async (t) => {
  const db = await setup(t, "demo");
  const app = createApp(db);
  const response = await app.request("/api/v2/feeds/demo/routes/r1/fleet");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.synthetic, true);
  assert.equal(body.data.liveSupported, false);
  assert.equal(
    (await app.request("/api/v2/feeds/demo/routes/missing/fleet")).status,
    404,
  );
  const sources = await (await app.request("/api/v2/sources?limit=200")).json();
  const byKey = new Map(sources.data.map((s) => [s.key, s]));
  for (const key of [
    "carris",
    "stcp",
    "carris-metropolitana",
    "metro-lisboa",
    "cp",
    "fertagus",
    "mts",
    "tcb",
  ])
    assert.equal(byKey.get(key).capabilities.liveVehicles, true);
  assert.equal(byKey.get("metro-porto").capabilities.liveVehicles, false);
  assert.equal(byKey.get("metro-porto").capabilities.routeMap, true);
});

const tmlPosition = {
  agency_id: "N18KL",
  vehicle_id: "[N18KL]18532",
  trip_id: "[76XA2][N18KL]t1",
  route_id: "[N18KL]SINTRA_1",
  pattern_id: "[N18KL]SINTRA_1_1",
  direction_id: "1",
  latitude: 38.7571,
  longitude: -9.2638,
  bearing: 38,
  created_at: now,
  stop_id: null,
};

test("cp observations join imported trips; hub route IDs are not a fallback", async (t) => {
  const db = await setup(t, "cp");
  const fleet = createRouteFleet(
    db,
    async (url) => {
      assert.ok(url.startsWith("https://go.tmlmobilidade.pt/hub/api/v1/"));
      return Response.json({
        data: [
          tmlPosition,
          {
            ...tmlPosition,
            vehicle_id: "[N18KL]99999",
            trip_id: "[76XA2][N18KL]unknown",
          },
        ],
      });
    },
    () => now,
  );
  const result = await fleet("cp", "r1");
  assert.equal(result.liveSupported, true);
  assert.equal(result.attribution, "Comboios de Portugal · TML GO");
  assert.equal(result.vehiclesUnavailable, false);
  assert.equal(result.vehicles.length, 1);
  assert.equal(result.vehicles[0].id, "18532");
  assert.equal(result.vehicles[0].patternId, tripPattern(db, "cp", "t1"));
  const tripDirection = db
    .prepare(
      "SELECT direction_id FROM trips WHERE feed_key = 'cp' AND trip_id = 't1'",
    )
    .get().direction_id;
  assert.equal(result.vehicles[0].direction, tripDirection ?? 1);
});

test("metro-lisboa observations join by line letter when trips are hub-native", async (t) => {
  const db = await setup(t, "metro-lisboa");
  const fleet = createRouteFleet(
    db,
    async () =>
      Response.json({
        data: [
          {
            agency_id: "IA2N9",
            vehicle_id: "[IA2N9]26B",
            trip_id: "[GB7GD][IA2N9]VER_B_2_1.A8",
            route_id: "[IA2N9]r1_0",
            direction_id: "1",
            latitude: 38.78,
            longitude: -9.16,
            bearing: 122,
            created_at: now,
          },
        ],
      }),
    () => now,
  );
  const result = await fleet("metro-lisboa", "r1");
  assert.equal(result.vehicles.length, 1);
  assert.equal(result.vehicles[0].id, "26B");
  assert.equal(result.vehicles[0].patternId, "");
  assert.equal(result.vehicles[0].direction, 1);
  assert.equal(result.attribution, "Metropolitano de Lisboa · TML GO");
});

test("mts and tcb fall back to native hub route IDs", async (t) => {
  const db = await setup(t, "mts");
  const fleet = createRouteFleet(
    db,
    async () =>
      Response.json({
        data: [
          {
            agency_id: "KB1F6",
            vehicle_id: "[KB1F6]101",
            trip_id: "[QLPGM][KB1F6]unknown",
            route_id: "[KB1F6]r1",
            direction_id: "0",
            latitude: 38.65,
            longitude: -9.15,
            bearing: null,
            created_at: now,
          },
        ],
      }),
    () => now,
  );
  const result = await fleet("mts", "r1");
  assert.equal(result.vehicles.length, 1);
  assert.equal(result.vehicles[0].patternId, "");
  assert.equal(result.vehicles[0].bearing, null);
});

test("a failed TML snapshot is unavailable, not an empty fleet", async (t) => {
  const db = await setup(t, "fertagus");
  const fleet = createRouteFleet(
    db,
    async () => new Response(null, { status: 503 }),
    () => now,
  );
  const result = await fleet("fertagus", "r1");
  assert.equal(result.vehiclesUnavailable, true);
  assert.deepEqual(result.vehicles, []);
  assert.equal(result.liveSupported, true);
});
