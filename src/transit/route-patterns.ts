import type { DatabaseSync } from "node:sqlite";

// A route variant ("pattern") shares the fleet view's grouping key so vehicle
// observations join the same way: [shape_id, direction_id, headsign].
type Variant = {
  shape_id: string | null;
  direction_id: number | null;
  headsign: string;
};
const patternId = (variant: Variant) =>
  JSON.stringify([variant.shape_id, variant.direction_id, variant.headsign]);

export type PatternStop = {
  sequence: number;
  id: string;
  name: string | null;
  code: string | null;
  latitude: number | null;
  longitude: number | null;
  arrivalTime: string | null;
  departureTime: string | null;
  pickupType: number;
  dropOffType: number;
};
export type RoutePattern = {
  id: string;
  headsign: string;
  direction: number | null;
  tripId: string;
  stops: PatternStop[];
  coordinates: [number, number][];
};
export type RoutePatterns = {
  feedKey: string;
  routeId: string;
  patterns: RoutePattern[];
  geometryUnavailable: boolean;
  patternsTruncated: boolean;
};

const maxPatterns = 30;
const maxStops = 2000;
const maxPoints = 20000;

function text(value: unknown) {
  return typeof value === "string" && value !== "" ? value : null;
}
function number(value: unknown) {
  const parsed = Number(value);
  return value !== null && value !== "" && Number.isFinite(parsed)
    ? parsed
    : null;
}
function integer(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

// Static anatomy of a route: each direction/variant with its ordered stops
// (names, coordinates and a representative trip's times) plus the drawn path.
// Cached per feed import, like the fleet geometry, because it changes only when
// the timetable is re-imported — not on every request.
export function createRoutePatterns(db: DatabaseSync) {
  const cache = new Map<string, RoutePatterns>();
  return (feedKey: string, routeId: string): RoutePatterns | null => {
    const route = db
      .prepare("SELECT 1 FROM routes WHERE feed_key = ? AND route_id = ?")
      .get(feedKey, routeId);
    if (!route) return null;
    const importedAt = db
      .prepare("SELECT imported_at FROM feeds WHERE feed_key = ?")
      .get(feedKey)?.imported_at;
    const cacheKey = JSON.stringify([feedKey, routeId, importedAt]);
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const trips = db
      .prepare(
        `SELECT trip.trip_id, trip.shape_id, trip.direction_id,
          COALESCE(json_extract(trip.record, '$.trip_headsign'), '') AS headsign,
          (SELECT COUNT(*) FROM stop_times AS times
            WHERE times.feed_key = trip.feed_key
              AND times.trip_id = trip.trip_id) AS stopCount
        FROM trips AS trip
        WHERE trip.feed_key = ? AND trip.route_id = ?`,
      )
      .all(feedKey, routeId) as (Variant & {
      trip_id: string;
      stopCount: number;
    })[];

    // Group trips into variants and keep the fullest trip as the representative
    // so the stop list shows the complete path rather than a short-turn.
    const groups = new Map<
      string,
      { variant: Variant; tripId: string; stopCount: number }
    >();
    for (const trip of trips) {
      const id = patternId(trip);
      const current = groups.get(id);
      if (
        !current ||
        trip.stopCount > current.stopCount ||
        (trip.stopCount === current.stopCount && trip.trip_id < current.tripId)
      ) {
        groups.set(id, {
          variant: trip,
          tripId: trip.trip_id,
          stopCount: trip.stopCount,
        });
      }
    }
    const ordered = [...groups.values()].sort(
      (a, b) =>
        (a.variant.direction_id ?? 0) - (b.variant.direction_id ?? 0) ||
        a.variant.headsign.localeCompare(b.variant.headsign) ||
        (a.variant.shape_id ?? "").localeCompare(b.variant.shape_id ?? ""),
    );
    const patternsTruncated = ordered.length > maxPatterns;

    const stopQuery = db.prepare(
      `SELECT times.stop_sequence AS sequence,
        times.record AS timeRecord, stop.record AS stopRecord, stop.stop_id
      FROM stop_times AS times
      JOIN stops AS stop
        ON stop.feed_key = times.feed_key AND stop.stop_id = times.stop_id
      WHERE times.feed_key = ? AND times.trip_id = ?
      ORDER BY times.stop_sequence LIMIT ?`,
    );
    const shapeQuery = db.prepare(
      `SELECT json_extract(record, '$.shape_pt_lat') AS lat,
        json_extract(record, '$.shape_pt_lon') AS lon
      FROM shapes WHERE feed_key = ? AND shape_id = ?
      ORDER BY shape_pt_sequence LIMIT ?`,
    );

    let geometryUnavailable = false;
    const patterns = ordered
      .slice(0, maxPatterns)
      .map(({ variant, tripId }) => {
        const rows = stopQuery.all(feedKey, tripId, maxStops + 1) as {
          sequence: number;
          timeRecord: string;
          stopRecord: string;
          stop_id: string;
        }[];
        if (rows.length > maxStops) geometryUnavailable = true;
        const stops = rows.slice(0, maxStops).map((row): PatternStop => {
          const stop = JSON.parse(row.stopRecord) as Record<string, unknown>;
          const time = JSON.parse(row.timeRecord) as Record<string, unknown>;
          return {
            sequence: row.sequence,
            id: row.stop_id,
            name: text(stop.stop_name),
            code: text(stop.stop_code),
            latitude: number(stop.stop_lat),
            longitude: number(stop.stop_lon),
            arrivalTime: text(time.arrival_time),
            departureTime: text(time.departure_time),
            pickupType: integer(time.pickup_type, 0),
            dropOffType: integer(time.drop_off_type, 0),
          };
        });

        const points = variant.shape_id
          ? (shapeQuery.all(feedKey, variant.shape_id, maxPoints + 1) as {
              lat: unknown;
              lon: unknown;
            }[])
          : [];
        if (points.length > maxPoints) geometryUnavailable = true;
        const coordinates = points
          .slice(0, maxPoints)
          .flatMap((point): [number, number][] => {
            const lat = Number(point.lat);
            const lon = Number(point.lon);
            return point.lat !== null &&
              point.lon !== null &&
              Number.isFinite(lat) &&
              Number.isFinite(lon) &&
              Math.abs(lat) <= 90 &&
              Math.abs(lon) <= 180
              ? [[lat, lon]]
              : [];
          });
        if (coordinates.length < 2) geometryUnavailable = true;
        return {
          id: patternId(variant),
          headsign: variant.headsign,
          direction: variant.direction_id,
          tripId,
          stops,
          coordinates: coordinates.length >= 2 ? coordinates : [],
        };
      });
    if (!patterns.length) geometryUnavailable = true;

    const result: RoutePatterns = {
      feedKey,
      routeId,
      patterns,
      geometryUnavailable,
      patternsTruncated,
    };
    if (cache.size >= 100) cache.delete(cache.keys().next().value!);
    cache.set(cacheKey, result);
    return result;
  };
}
