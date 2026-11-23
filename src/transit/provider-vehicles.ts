import { transit_realtime as rt } from "gtfs-realtime-bindings";

export const liveProviders = new Set([
  "carris",
  "stcp",
  "carris-metropolitana",
  "metro-lisboa",
  "cp",
  "fertagus",
  "mts",
  "tcb",
]);
export type Observation = {
  id: string;
  tripId: string;
  routeId: string;
  direction: number | null;
  latitude: number;
  longitude: number;
  bearing: number | null;
  observedAt: number;
};
const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
const text = (v: unknown) => (typeof v === "string" ? v : "");
const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

export function validObservations(values: Observation[], now: number) {
  const unique = new Map<string, Observation>();
  for (const v of values) {
    if (
      !v.id ||
      !finite(v.latitude) ||
      Math.abs(v.latitude) > 90 ||
      !finite(v.longitude) ||
      Math.abs(v.longitude) > 180 ||
      !finite(v.observedAt) ||
      v.observedAt > now + 30_000 ||
      now - v.observedAt > 600_000
    )
      continue;
    if (!unique.has(v.id) || unique.get(v.id)!.observedAt < v.observedAt)
      unique.set(v.id, {
        ...v,
        bearing:
          finite(v.bearing) && v.bearing >= 0 && v.bearing < 360
            ? v.bearing
            : null,
      });
  }
  return [...unique.values()];
}

export function decodeCarris(bytes: Uint8Array): Observation[] {
  const feed = rt.FeedMessage.decode(bytes);
  // A snapshot adapter must not silently treat differential feeds as full fleets.
  if (feed.header.incrementality === rt.FeedHeader.Incrementality.DIFFERENTIAL)
    throw new Error("Differential feed unsupported");
  return feed.entity.flatMap((entity) => {
    const v = entity.vehicle;
    if (entity.isDeleted || !v?.position || !v.timestamp || !v.vehicle?.id)
      return [];
    return [
      {
        id: v.vehicle.id,
        tripId: v.trip?.tripId ?? "",
        routeId: v.trip?.routeId ?? "",
        direction:
          v.trip?.directionId === 0 || v.trip?.directionId === 1
            ? v.trip.directionId
            : null,
        latitude: v.position.latitude,
        longitude: v.position.longitude,
        bearing: Object.hasOwn(v.position, "bearing")
          ? (v.position.bearing ?? null)
          : null,
        observedAt: Number(v.timestamp) * 1000,
      },
    ];
  });
}

export function decodeStcp(value: unknown): Observation[] {
  if (!Array.isArray(value)) throw new Error("Invalid STCP snapshot");
  return value.flatMap((item) => {
    const v = record(item);
    if (record(v.dataProvider).value !== "STCP") return [];
    const annotations = record(v.annotations).value;
    const tags = Array.isArray(annotations)
      ? annotations.filter((x): x is string => typeof x === "string")
      : [];
    const tag = (name: string) =>
      tags.find((s) => s.startsWith(name))?.slice(name.length) ?? "";
    const coordinates = record(record(v.location).value).coordinates;
    if (
      !Array.isArray(coordinates) ||
      !finite(coordinates[0]) ||
      !finite(coordinates[1])
    )
      return [];
    const direction = tag("stcp:sentido:");
    return [
      {
        id: text(record(v.fleetVehicleId).value),
        tripId: tag("stcp:nr_viagem:"),
        routeId: tag("stcp:route:"),
        direction: direction === "0" ? 0 : direction === "1" ? 1 : null,
        latitude: coordinates[1],
        longitude: coordinates[0],
        bearing: finite(record(v.bearing).value)
          ? (record(v.bearing).value as number)
          : null,
        observedAt: Date.parse(text(record(v.observationDateTime).value)),
      },
    ];
  });
}

export function createProviderVehicles(
  request: typeof fetch = fetch,
  clock = Date.now,
) {
  const cache = new Map<string, { expires: number; value: Observation[] }>();
  const pending = new Map<string, Promise<Observation[]>>();
  return async (feed: "carris" | "stcp") => {
    const cached = cache.get(feed);
    if (cached && cached.expires > clock())
      return validObservations(cached.value, clock());
    let work = pending.get(feed);
    if (!work) {
      work = (async () => {
        const url =
          feed === "carris"
            ? "https://gateway.carris.pt/gateway/gtfs/api/v2.11/GTFS/realtime/vehiclepositions"
            : "https://broker.fiware.urbanplatform.portodigital.pt/v2/entities?q=vehicleType==bus&limit=1000";
        const response = await request(url, {
          signal: AbortSignal.timeout(6000),
          redirect: "error",
        });
        if (!response.ok) throw new Error("Vehicle provider unavailable");
        const value =
          feed === "carris"
            ? decodeCarris(new Uint8Array(await response.arrayBuffer()))
            : decodeStcp(await response.json());
        cache.set(feed, { expires: clock() + 10_000, value });
        return validObservations(value, clock());
      })();
      pending.set(feed, work);
    }
    try {
      return await work;
    } finally {
      pending.delete(feed);
    }
  };
}
