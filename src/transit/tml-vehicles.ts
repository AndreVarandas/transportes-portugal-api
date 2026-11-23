import { publicId } from "./live-fleet";
import { validObservations, type Observation } from "./provider-vehicles";

// TML GO hub: the official aggregated realtime feed for Lisbon metropolitan
// area operators. The organization ID scopes the public open-data snapshot;
// agency IDs map observations onto the imported GTFS feeds. IDs carry
// [plan][agency] prefixes that must be stripped before joining GTFS records.
// Carris is deliberately absent: it keeps its direct official GTFS-RT feed.
const origin =
  "https://go.tmlmobilidade.pt/hub/api/v1/0XJC9/vehicles/positions";
const agencyFeeds = new Map([
  ["IA2N9", "metro-lisboa"],
  ["N18KL", "cp"],
  ["7NTB1", "fertagus"],
  ["KB1F6", "mts"],
  ["A3H3M", "tcb"],
]);
export const tmlProviders = new Set(agencyFeeds.values());

type Row = Record<string, unknown>;
const row = (value: unknown): Row =>
  value && typeof value === "object" ? (value as Row) : {};
const str = (value: unknown) => (typeof value === "string" ? value : "");
const number = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

export type TmlObservation = Observation & { feedKey: string };

export function decodeTml(value: unknown): TmlObservation[] {
  const body = row(value);
  if (!Array.isArray(body.data) || body.error != null)
    throw new Error("Invalid TML snapshot");
  return body.data.flatMap((item): TmlObservation[] => {
    const v = row(item);
    const feedKey = agencyFeeds.get(str(v.agency_id));
    if (
      !feedKey ||
      !publicId(v.vehicle_id) ||
      !number(v.latitude) ||
      !number(v.longitude) ||
      !number(v.created_at)
    )
      return [];
    const direction = Number(v.direction_id);
    return [
      {
        feedKey,
        id: publicId(v.vehicle_id),
        tripId: publicId(v.trip_id),
        routeId: publicId(v.route_id),
        direction: direction === 0 || direction === 1 ? direction : null,
        latitude: v.latitude,
        longitude: v.longitude,
        bearing: number(v.bearing) ? v.bearing : null,
        observedAt: v.created_at < 1e12 ? v.created_at * 1000 : v.created_at,
      },
    ];
  });
}

export function createTmlVehicles(
  request: typeof fetch = fetch,
  clock = Date.now,
) {
  let cached: { expires: number; value: TmlObservation[] } | null = null;
  let pending: Promise<TmlObservation[]> | null = null;
  async function load(): Promise<TmlObservation[]> {
    if (cached && cached.expires > clock()) return cached.value;
    if (!pending) {
      pending = (async () => {
        const response = await request(origin, {
          signal: AbortSignal.timeout(6000),
          redirect: "error",
        });
        if (!response.ok) throw new Error("Vehicle provider unavailable");
        const value = decodeTml(await response.json());
        cached = { expires: clock() + 10_000, value };
        return value;
      })();
    }
    try {
      return await pending;
    } finally {
      pending = null;
    }
  }
  return async (feedKey: string) => {
    const all = await load();
    return validObservations(
      all.filter((v) => v.feedKey === feedKey),
      clock(),
    );
  };
}
