const assert = require("node:assert/strict");
const test = require("node:test");
const {
  normalizeVehicles,
  createFleetService,
} = require("../dist/transit/live-fleet");
const now = Date.parse("2026-11-21T12:00:00Z");
const vehicle = {
  id: "bus",
  line_id: "1708",
  pattern_id: "[version][operator]1708_0_3",
  lat: 38.7,
  lon: -9.1,
  bearing: 0,
  timestamp: now,
  direction_id: 0,
};
test("normalizes units and versioned patterns, deduplicates, excludes invalid and very old positions", () => {
  const data = normalizeVehicles(
    [
      vehicle,
      { ...vehicle, timestamp: now - 2000 },
      { ...vehicle, id: "seconds", timestamp: now / 1000 },
      { ...vehicle, id: "stale", timestamp: now - 100000 },
      { ...vehicle, id: "old", timestamp: now - 700000 },
      { ...vehicle, id: "future", timestamp: now + 60000 },
      { ...vehicle, id: "bad", lat: null },
      { ...vehicle, id: "other", line_id: "1001" },
      { ...vehicle, id: "[YA15B]2272", timestamp: now - 3000 },
    ],
    "1708",
    now,
  );
  assert.deepEqual(
    data.map((v) => v.id),
    ["bus", "seconds", "stale", "2272"],
  );
  assert.equal(data[0].patternId, "1708_0_3");
  assert.equal(data[0].bearing, 0);
  assert.equal(data[1].observedAt, now);
});
test("shares requests, selects current geometry and preserves empty success versus upstream failures", async () => {
  let calls = 0;
  const request = async (url) => {
    calls++;
    const path = new URL(url).pathname;
    const value = path.endsWith("/lines")
      ? [{ id: "1708", long_name: "Circular", pattern_ids: ["1708_0_3"] }]
      : path.endsWith("/vehicles")
        ? []
        : path.includes("/patterns/")
          ? [
              { id: "1708_0_3", valid_on: ["20260101"], shape_id: "old" },
              {
                id: "1708_0_3",
                valid_on: ["20261121"],
                headsign: "Casal Mira",
                direction_id: 0,
                shape_id: "current",
              },
            ]
          : {
              geojson: {
                geometry: {
                  coordinates: [
                    [-9.1, 38.7],
                    [-9.2, 38.8],
                  ],
                },
              },
            };
    return Response.json(value);
  };
  const fleet = createFleetService(request, () => now);
  const [first, second] = await Promise.all([fleet("1708"), fleet("1708")]);
  assert.deepEqual(first, second);
  assert.equal(calls, 4);
  assert.equal(first.vehicles.length, 0);
  assert.deepEqual(first.patterns[0].coordinates[0], [38.7, -9.1]);
  assert.equal(first.geometryUnavailable, false);
  assert.equal(await fleet("9999"), null);
  await assert.rejects(
    createFleetService(
      async () => new Response(null, { status: 503 }),
      () => now,
    )("1708"),
  );
});
test("a shape failure does not hide valid vehicle reports", async () => {
  const fleet = createFleetService(
    async (url) => {
      const path = new URL(url).pathname;
      if (path.includes("/shapes/")) return new Response(null, { status: 500 });
      return Response.json(
        path.endsWith("/lines")
          ? [{ id: "1708", pattern_ids: ["1708_0_3"] }]
          : path.endsWith("/vehicles")
            ? [vehicle]
            : [{ id: "1708_0_3", valid_on: ["20261121"], shape_id: "bad" }],
      );
    },
    () => now,
  );
  const result = await fleet("1708");
  assert.equal(result.vehicles.length, 1);
  assert.equal(result.geometryUnavailable, true);
});

test("vehicle-feed failure preserves route metadata and is not an empty fleet", async () => {
  for (const malformed of [false, true]) {
    const fleet = createFleetService(
      async (url) => {
        if (new URL(url).pathname.endsWith("/vehicles"))
          return malformed
            ? Response.json({ error: "bad payload" })
            : new Response(null, { status: 503 });
        return Response.json([
          { id: "3510", long_name: "Cacilhas - Lazarim", pattern_ids: [] },
        ]);
      },
      () => now,
    );
    const result = await fleet("3510");
    assert.equal(result.name, "Cacilhas - Lazarim");
    assert.equal(result.vehiclesUnavailable, true);
    assert.deepEqual(result.vehicles, []);
  }
});
