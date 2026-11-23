// Carris Metropolitana owns the live observations. Never infer positions from schedules.
const origin = "https://api.carrismetropolitana.pt/v2";
type Row = Record<string, unknown>;
const row = (value: unknown): Row =>
  value && typeof value === "object" ? (value as Row) : {};
const rows = (value: unknown): Row[] =>
  Array.isArray(value) ? value.map(row) : [];
const str = (value: unknown) => (typeof value === "string" ? value : "");
export const publicId = (value: unknown) =>
  str(value).replace(/^(?:\[[^\]]+\])+/, "");
const number = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
export const freshForMs = 90_000;

export function normalizeVehicles(value: unknown, lineId: string, now: number) {
  const unique = new Map<
    string,
    {
      id: string;
      patternId: string;
      direction: number | null;
      latitude: number;
      longitude: number;
      bearing: number | null;
      observedAt: number;
    }
  >();
  for (const v of rows(value)) {
    if (
      v.line_id !== lineId ||
      !str(v.id) ||
      !number(v.lat) ||
      !number(v.lon) ||
      Math.abs(v.lat) > 90 ||
      Math.abs(v.lon) > 180 ||
      !number(v.timestamp)
    )
      continue;
    const observedAt = v.timestamp < 1e12 ? v.timestamp * 1000 : v.timestamp;
    if (observedAt > now + 30_000 || now - observedAt > 600_000) continue;
    const id = publicId(v.id);
    const previous = unique.get(id);
    if (previous && previous.observedAt >= observedAt) continue;
    unique.set(id, {
      id,
      patternId: publicId(v.pattern_id),
      direction:
        v.direction_id === 0 || v.direction_id === 1 ? v.direction_id : null,
      latitude: v.lat,
      longitude: v.lon,
      bearing:
        number(v.bearing) && v.bearing >= 0 && v.bearing < 360
          ? v.bearing
          : null,
      observedAt,
    });
  }
  return [...unique.values()];
}

export function createFleetService(
  request: typeof fetch = fetch,
  clock = Date.now,
) {
  const cache = new Map<string, { expires: number; value: unknown }>();
  const pending = new Map<string, Promise<unknown>>();
  async function get(path: string, ttl: number): Promise<unknown> {
    const cached = cache.get(path);
    if (cached && cached.expires > clock()) return cached.value;
    const existing = pending.get(path);
    if (existing) return existing;
    const work = (async () => {
      const response = await request(origin + path, {
        signal: AbortSignal.timeout(4500),
        redirect: "error",
      });
      if (!response.ok) throw new Error("Live upstream unavailable");
      const value: unknown = await response.json();
      if (cache.size >= 300) cache.delete(cache.keys().next().value!);
      cache.set(path, { value, expires: clock() + ttl });
      return value;
    })();
    pending.set(path, work);
    try {
      return await work;
    } finally {
      pending.delete(path);
    }
  }
  return async (lineId: string) => {
    const [catalog, vehicleResult] = await Promise.all([
      get("/lines", 300_000),
      get("/vehicles", 10_000).then(
        (value) => ({ value, unavailable: !Array.isArray(value) }),
        () => ({ value: [], unavailable: true }),
      ),
    ]);
    if (!Array.isArray(catalog)) throw new Error("Invalid live response");
    const line = rows(catalog).find((item) => item.id === lineId);
    if (!line) return null;
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Lisbon",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .format(new Date(clock()))
      .replaceAll("-", "");
    let geometryUnavailable = false;
    const patterns = (
      await Promise.all(
        (Array.isArray(line.pattern_ids)
          ? line.pattern_ids
              .filter((id): id is string => typeof id === "string")
              .slice(0, 30)
          : []
        ).map(async (id) => {
          try {
            const versions = rows(
              await get(`/patterns/${encodeURIComponent(id)}`, 300_000),
            );
            const pattern = versions.find(
              (p) => Array.isArray(p.valid_on) && p.valid_on.includes(today),
            );
            if (!pattern) return null;
            let coordinates: [number, number][] = [];
            try {
              const shape = row(
                await get(
                  `/shapes/${encodeURIComponent(str(pattern.shape_id))}`,
                  300_000,
                ),
              );
              const points = row(row(shape.geojson).geometry).coordinates;
              if (Array.isArray(points))
                coordinates = points
                  .filter(
                    (p): p is [number, number] =>
                      Array.isArray(p) &&
                      p.length >= 2 &&
                      number(p[0]) &&
                      number(p[1]) &&
                      Math.abs(p[0]) <= 180 &&
                      Math.abs(p[1]) <= 90,
                  )
                  .map(([lon, lat]) => [lat, lon]);
              if (!coordinates.length) geometryUnavailable = true;
            } catch {
              geometryUnavailable = true;
            }
            return {
              id: publicId(pattern.id),
              headsign: str(pattern.headsign),
              direction:
                pattern.direction_id === 0 || pattern.direction_id === 1
                  ? pattern.direction_id
                  : null,
              coordinates,
            };
          } catch {
            geometryUnavailable = true;
            return null;
          }
        }),
      )
    ).filter((p) => p !== null);
    return {
      lineId,
      name: str(line.long_name),
      fetchedAt: clock(),
      freshForMs,
      vehiclesUnavailable: vehicleResult.unavailable,
      vehicles: normalizeVehicles(vehicleResult.value, lineId, clock()),
      patterns,
      geometryUnavailable: geometryUnavailable || !patterns.length,
    };
  };
}
