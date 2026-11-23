const assert = require("node:assert/strict");
const test = require("node:test");
const {
  decodeTml,
  createTmlVehicles,
} = require("../dist/transit/tml-vehicles");

const now = Date.parse("2026-11-21T12:00:00Z");
const position = {
  agency_id: "IA2N9",
  vehicle_id: "[IA2N9]26B",
  trip_id: "[GB7GD][IA2N9]VER_B_2_6.B41",
  route_id: "[IA2N9]B_0",
  pattern_id: "[IA2N9]B_0_0",
  direction_id: "0",
  latitude: 38.78115,
  longitude: -9.162583,
  bearing: 122,
  created_at: now,
  stop_id: "AX",
};

test("decodeTml strips plan and agency prefixes and maps agencies to feeds", () => {
  const result = decodeTml({
    data: [
      position,
      {
        ...position,
        agency_id: "N18KL",
        vehicle_id: "[N18KL]18532",
        trip_id: "[76XA2][N18KL]18532_20251214",
        route_id: "[N18KL]SINTRA_1",
        direction_id: "1",
        bearing: null,
        stop_id: null,
      },
      { ...position, agency_id: "UNKNOWN" },
      { ...position, agency_id: "LTP61" },
      { ...position, vehicle_id: "" },
      { ...position, latitude: null },
      { ...position, created_at: undefined },
    ],
  });
  assert.equal(result.length, 2);
  assert.deepEqual(result[0], {
    feedKey: "metro-lisboa",
    id: "26B",
    tripId: "VER_B_2_6.B41",
    routeId: "B_0",
    direction: 0,
    latitude: 38.78115,
    longitude: -9.162583,
    bearing: 122,
    observedAt: now,
  });
  assert.equal(result[1].feedKey, "cp");
  assert.equal(result[1].id, "18532");
  assert.equal(result[1].tripId, "18532_20251214");
  assert.equal(result[1].routeId, "SINTRA_1");
  assert.equal(result[1].direction, 1);
  assert.equal(result[1].bearing, null);
  assert.throws(() => decodeTml({}));
  assert.throws(() => decodeTml({ data: {} }));
  assert.throws(() => decodeTml({ data: [], error: "upstream failure" }));
});

test("decodeTml accepts second timestamps and invalid directions", () => {
  const [vehicle] = decodeTml({
    data: [{ ...position, created_at: now / 1000, direction_id: "7" }],
  });
  assert.equal(vehicle.observedAt, now);
  assert.equal(vehicle.direction, null);
});

test("createTmlVehicles shares one snapshot across feeds and caches for ten seconds", async () => {
  let calls = 0;
  let current = now;
  const request = async (url) => {
    calls++;
    assert.equal(
      url,
      "https://go.tmlmobilidade.pt/hub/api/v1/0XJC9/vehicles/positions",
    );
    return Response.json({
      data: [
        position,
        { ...position, agency_id: "N18KL", vehicle_id: "[N18KL]18532" },
      ],
    });
  };
  const vehicles = createTmlVehicles(request, () => current);
  const [ml, cp] = await Promise.all([
    vehicles("metro-lisboa"),
    vehicles("cp"),
  ]);
  assert.equal(calls, 1);
  assert.equal(ml.length, 1);
  assert.equal(cp.length, 1);
  assert.equal(ml[0].id, "26B");
  await vehicles("metro-lisboa");
  assert.equal(calls, 1);
  current = now + 11_000;
  await vehicles("metro-lisboa");
  assert.equal(calls, 2);
  assert.deepEqual(await vehicles("stcp"), []);
});

test("createTmlVehicles ages out old reports and retries after failures", async () => {
  let current = now;
  const vehicles = createTmlVehicles(
    async () => Response.json({ data: [position] }),
    () => current,
  );
  assert.equal((await vehicles("metro-lisboa")).length, 1);
  current = now + 601_000;
  assert.deepEqual(await vehicles("metro-lisboa"), []);

  let failing = true;
  const flaky = createTmlVehicles(
    async () => {
      if (failing) return new Response(null, { status: 503 });
      return Response.json({ data: [position] });
    },
    () => now,
  );
  await assert.rejects(flaky("metro-lisboa"));
  failing = false;
  assert.equal((await flaky("metro-lisboa")).length, 1);
});
