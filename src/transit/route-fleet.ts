import type { DatabaseSync } from "node:sqlite";
import { createFleetService, freshForMs } from "./live-fleet";
import { createProviderVehicles, liveProviders } from "./provider-vehicles";
import { sources } from "./sources";
import { createTmlVehicles, tmlProviders } from "./tml-vehicles";

type Pattern = {
  id: string;
  headsign: string;
  direction: number | null;
  coordinates: [number, number][];
};
type Trip = {
  shape_id: string | null;
  direction_id: number | null;
  headsign: string;
};
const patternId = (trip: Trip) =>
  JSON.stringify([trip.shape_id, trip.direction_id, trip.headsign]);

export function createRouteFleet(
  db: DatabaseSync,
  request: typeof fetch = fetch,
  clock = Date.now,
) {
  const cm = createFleetService(request, clock);
  const observations = createProviderVehicles(request, clock);
  const tml = createTmlVehicles(request, clock);
  const geometryCache = new Map<
    string,
    { patterns: Pattern[]; geometryUnavailable: boolean }
  >();
  return async (feedKey: string, routeId: string) => {
    const route = db
      .prepare("SELECT record FROM routes WHERE feed_key = ? AND route_id = ?")
      .get(feedKey, routeId);
    if (!route) return null;
    const metadata = JSON.parse(String(route.record)) as {
      route_short_name?: string;
      route_long_name?: string;
    };
    const provider = sources.get(feedKey)?.name ?? feedKey;
    // Carris Metropolitana only has a live source through its four-digit public
    // line catalogue, handled below. Everything else uses the provider map.
    const liveSupported =
      liveProviders.has(feedKey) && feedKey !== "carris-metropolitana";
    const lineId = metadata.route_short_name || routeId;
    const common = {
      feedKey,
      routeId,
      provider,
      liveSupported,
      synthetic: feedKey === "demo",
    };
    if (feedKey === "carris-metropolitana" && /^\d{4}$/.test(lineId)) {
      const fleet = await cm(lineId);
      if (!fleet) return null;
      return {
        ...fleet,
        ...common,
        liveSupported: true,
        attribution: provider,
      };
    }
    const importedAt = db
      .prepare("SELECT imported_at FROM feeds WHERE feed_key = ?")
      .get(feedKey)?.imported_at;
    const cacheKey = JSON.stringify([feedKey, routeId, importedAt]);
    let geometry = geometryCache.get(cacheKey);
    if (!geometry) {
      // Group by actual variant, rather than arbitrarily taking the first trips.
      const variants = db
        .prepare(
          `SELECT DISTINCT shape_id, direction_id,
        COALESCE(json_extract(record, '$.trip_headsign'), '') AS headsign
        FROM trips WHERE feed_key = ? AND route_id = ?
        ORDER BY direction_id, headsign, shape_id LIMIT 31`,
        )
        .all(feedKey, routeId) as Trip[];
      let missing = variants.length > 30 || !variants.length;
      const patterns = variants.slice(0, 30).map((trip): Pattern => {
        const points = trip.shape_id
          ? db
              .prepare(
                `SELECT json_extract(record, '$.shape_pt_lat') AS lat,
          json_extract(record, '$.shape_pt_lon') AS lon FROM shapes WHERE feed_key = ? AND shape_id = ?
          ORDER BY shape_pt_sequence LIMIT 20001`,
              )
              .all(feedKey, trip.shape_id)
          : [];
        if (points.length > 20000) missing = true;
        const coordinates = points
          .slice(0, 20000)
          .flatMap((p): [number, number][] => {
            const lat = Number(p.lat),
              lon = Number(p.lon);
            return p.lat !== null &&
              p.lon !== null &&
              Number.isFinite(lat) &&
              Number.isFinite(lon) &&
              Math.abs(lat) <= 90 &&
              Math.abs(lon) <= 180
              ? [[lat, lon]]
              : [];
          });
        if (coordinates.length < 2) missing = true;
        return {
          id: patternId(trip),
          headsign: trip.headsign,
          direction: trip.direction_id,
          coordinates: coordinates.length >= 2 ? coordinates : [],
        };
      });
      geometry = { patterns, geometryUnavailable: missing };
      if (geometryCache.size >= 100)
        geometryCache.delete(geometryCache.keys().next().value!);
      geometryCache.set(cacheKey, geometry);
    }
    let vehiclesUnavailable = false;
    const vehicles = [];
    if (
      feedKey === "carris" ||
      feedKey === "stcp" ||
      tmlProviders.has(feedKey)
    ) {
      try {
        const snapshot =
          feedKey === "carris" || feedKey === "stcp"
            ? await observations(feedKey)
            : await tml(feedKey);
        const tripLookup = db.prepare(`SELECT shape_id, direction_id, route_id,
          COALESCE(json_extract(record, '$.trip_headsign'), '') AS headsign
          FROM trips WHERE feed_key = ? AND trip_id = ?`);
        for (const v of snapshot) {
          const trip = v.tripId
            ? (tripLookup.get(feedKey, v.tripId) as
                (Trip & { route_id: string }) | undefined)
            : undefined;
          // Prefer an exact GTFS trip join. STCP public line labels are not route IDs,
          // and its live trip IDs carry schedule variants that differ from GTFS, so
          // the reported route plus direction is the reliable join.
          // TML hub route IDs are operator-native for Fertagus, MTS, and TCB;
          // Metro Lisboa encodes the line letter plus a direction suffix.
          const belongs = trip
            ? trip.route_id === routeId
            : feedKey === "carris" ||
                feedKey === "stcp" ||
                feedKey === "fertagus" ||
                feedKey === "mts" ||
                feedKey === "tcb"
              ? v.routeId === routeId
              : feedKey === "metro-lisboa" &&
                v.routeId.split("_")[0] === routeId;
          if (!belongs) continue;
          vehicles.push({
            id: v.id,
            patternId: trip ? patternId(trip) : "",
            direction: trip?.direction_id ?? v.direction,
            latitude: v.latitude,
            longitude: v.longitude,
            bearing: v.bearing,
            observedAt: v.observedAt,
          });
        }
      } catch {
        vehiclesUnavailable = true;
      }
    }
    // Some feeds use placeholder long names such as "-"; fall back to the short name.
    const longName = (metadata.route_long_name ?? "").trim();
    return {
      ...common,
      lineId,
      name: /[\p{L}\p{N}]/u.test(longName) ? longName : lineId,
      fetchedAt: clock(),
      freshForMs,
      ...geometry,
      vehicles,
      vehiclesUnavailable,
      attribution:
        feedKey === "stcp"
          ? "STCP · Porto Digital"
          : tmlProviders.has(feedKey)
            ? `${provider} · TML GO`
            : provider,
    };
  };
}
