const assert = require("node:assert/strict");
const test = require("node:test");
const { transit_realtime: rt } = require("gtfs-realtime-bindings");
const {
  validObservations,
  decodeCarris,
  decodeStcp,
  createProviderVehicles,
} = require("../dist/transit/provider-vehicles");

const now = Date.parse("2026-11-21T12:00:00Z");
const observation = {
  id: "v1",
  tripId: "t1",
  routeId: "r1",
  direction: 0,
  latitude: 38.7,
  longitude: -9.1,
  bearing: 90,
  observedAt: now,
};

test("validObservations deduplicates by vehicle, ages reports, and normalizes bearing", () => {
  const result = validObservations(
    [
      observation,
      { ...observation, observedAt: now - 1000 },
      { ...observation, id: "old", observedAt: now - 601_000 },
      { ...observation, id: "future", observedAt: now + 31_000 },
      { ...observation, id: "bad-lat", latitude: 91 },
      { ...observation, id: "bad-lon", longitude: 181 },
      { ...observation, id: "bad-time", observedAt: Number.NaN },
      { ...observation, id: "" },
      { ...observation, id: "bearing", bearing: 360 },
    ],
    now,
  );
  assert.deepEqual(
    result.map((v) => v.id),
    ["v1", "bearing"],
  );
  assert.equal(result[0].observedAt, now);
  assert.equal(result[1].bearing, null);
});

function carrisResponse(entities = [], incrementality = 0) {
  const bytes = rt.FeedMessage.encode({
    header: { gtfsRealtimeVersion: "2.0", incrementality },
    entity: entities,
  }).finish();
  return new Response(bytes);
}

const carrisEntity = {
  id: "e1",
  vehicle: {
    vehicle: { id: "bus-1" },
    trip: { tripId: "t1", routeId: "r1", directionId: 1 },
    position: { latitude: 38.7, longitude: -9.1, bearing: 90 },
    timestamp: now / 1000,
  },
};

test("decodeCarris maps full snapshots and rejects differential feeds", () => {
  const bytes = new Uint8Array(
    rt.FeedMessage.encode({
      header: { gtfsRealtimeVersion: "2.0", incrementality: 0 },
      entity: [
        carrisEntity,
        { id: "e2", vehicle: { ...carrisEntity.vehicle, position: undefined } },
        { id: "e3", isDeleted: true, vehicle: carrisEntity.vehicle },
      ],
    }).finish(),
  );
  const result = decodeCarris(bytes);
  assert.equal(result.length, 1);
  // GTFS-RT positions are float32, so coordinates round-trip approximately.
  const { latitude, longitude, ...rest } = result[0];
  assert.deepEqual(rest, {
    id: "bus-1",
    tripId: "t1",
    routeId: "r1",
    direction: 1,
    bearing: 90,
    observedAt: now,
  });
  assert.ok(Math.abs(latitude - 38.7) < 0.0001);
  assert.ok(Math.abs(longitude - -9.1) < 0.0001);
  const differential = rt.FeedMessage.encode({
    header: { gtfsRealtimeVersion: "2.0", incrementality: 1 },
    entity: [carrisEntity],
  }).finish();
  assert.throws(() => decodeCarris(new Uint8Array(differential)));
});

const stcpEntity = {
  dataProvider: { value: "STCP" },
  annotations: {
    value: ["stcp:sentido:1", "stcp:nr_viagem:t9", "stcp:route:400"],
  },
  location: { value: { coordinates: [-8.6, 41.15] } },
  fleetVehicleId: { value: "123" },
  bearing: { value: 270 },
  observationDateTime: { value: "2026-11-21T12:00:00Z" },
};

test("decodeStcp maps FIWare entities and skips foreign or malformed records", () => {
  assert.throws(() => decodeStcp({}));
  const result = decodeStcp([
    stcpEntity,
    { ...stcpEntity, dataProvider: { value: "OTHER" } },
    { ...stcpEntity, location: { value: {} } },
    {
      ...stcpEntity,
      fleetVehicleId: { value: "no-tags" },
      annotations: { value: [] },
      bearing: undefined,
    },
  ]);
  assert.equal(result.length, 2);
  assert.deepEqual(result[0], {
    id: "123",
    tripId: "t9",
    routeId: "400",
    direction: 1,
    latitude: 41.15,
    longitude: -8.6,
    bearing: 270,
    observedAt: now,
  });
  assert.equal(result[1].tripId, "");
  assert.equal(result[1].direction, null);
  assert.equal(result[1].bearing, null);
});

test("createProviderVehicles caches for ten seconds and shares concurrent work", async () => {
  let calls = 0;
  let current = now;
  const request = async (url) => {
    calls++;
    assert.ok(url.startsWith("https://gateway.carris.pt"));
    return carrisResponse([carrisEntity]);
  };
  const observations = createProviderVehicles(request, () => current);
  const [first, second] = await Promise.all([
    observations("carris"),
    observations("carris"),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(first, second);
  await observations("carris");
  assert.equal(calls, 1);
  current = now + 11_000;
  await observations("carris");
  assert.equal(calls, 2);
});

test("createProviderVehicles reads the STCP broker and retries after failures", async () => {
  let calls = 0;
  const request = async (url) => {
    calls++;
    assert.ok(
      url.startsWith("https://broker.fiware.urbanplatform.portodigital.pt"),
    );
    return Response.json([stcpEntity]);
  };
  const result = await createProviderVehicles(request, () => now)("stcp");
  assert.equal(result[0].id, "123");
  assert.equal(calls, 1);

  let failing = true;
  const flaky = createProviderVehicles(
    async () => {
      if (failing) return new Response(null, { status: 503 });
      return carrisResponse([carrisEntity]);
    },
    () => now,
  );
  await assert.rejects(flaky("carris"));
  failing = false;
  assert.equal((await flaky("carris")).length, 1);
});
