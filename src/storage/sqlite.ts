import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { relatedFilters, Resource, resources, tableName } from "./resources";

export function openDatabase(
  path = process.env.SQLITE_PATH || "data/transit.sqlite",
) {
  if (path !== ":memory:") {
    mkdirSync(dirname(resolve(path)), { recursive: true });
  }

  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
    const version = db.prepare("PRAGMA user_version").get()?.user_version;
    if (version === 0) {
      db.exec(`
                BEGIN IMMEDIATE;
                CREATE TABLE IF NOT EXISTS feeds (
                    feed_key TEXT PRIMARY KEY,
                    imported_at TEXT NOT NULL
                ) STRICT;
                CREATE TABLE IF NOT EXISTS feed_imports (
                    feed_key TEXT PRIMARY KEY REFERENCES feeds(feed_key),
                    digest TEXT NOT NULL
                ) STRICT;
                CREATE TABLE IF NOT EXISTS agencies (
                    feed_key TEXT NOT NULL REFERENCES feeds(feed_key),
                    agency_id TEXT NOT NULL,
                    record TEXT NOT NULL,
                    PRIMARY KEY (feed_key, agency_id)
                ) STRICT;
                CREATE TABLE IF NOT EXISTS routes (
                    feed_key TEXT NOT NULL,
                    route_id TEXT NOT NULL,
                    agency_id TEXT NOT NULL,
                    record TEXT NOT NULL,
                    PRIMARY KEY (feed_key, route_id),
                    FOREIGN KEY (feed_key, agency_id) REFERENCES agencies(feed_key, agency_id)
                ) STRICT;
                CREATE TABLE IF NOT EXISTS stops (
                    feed_key TEXT NOT NULL REFERENCES feeds(feed_key),
                    stop_id TEXT NOT NULL,
                    record TEXT NOT NULL,
                    PRIMARY KEY (feed_key, stop_id)
                ) STRICT;
                CREATE TABLE IF NOT EXISTS trips (
                    feed_key TEXT NOT NULL,
                    trip_id TEXT NOT NULL,
                    route_id TEXT NOT NULL,
                    service_id TEXT NOT NULL,
                    direction_id INTEGER,
                    shape_id TEXT,
                    record TEXT NOT NULL,
                    PRIMARY KEY (feed_key, trip_id),
                    FOREIGN KEY (feed_key, route_id) REFERENCES routes(feed_key, route_id)
                ) STRICT;
                CREATE TABLE IF NOT EXISTS stop_times (
                    feed_key TEXT NOT NULL,
                    trip_id TEXT NOT NULL,
                    stop_sequence INTEGER NOT NULL,
                    stop_id TEXT NOT NULL,
                    record TEXT NOT NULL,
                    PRIMARY KEY (feed_key, trip_id, stop_sequence),
                    FOREIGN KEY (feed_key, trip_id) REFERENCES trips(feed_key, trip_id),
                    FOREIGN KEY (feed_key, stop_id) REFERENCES stops(feed_key, stop_id)
                ) STRICT;
                CREATE TABLE IF NOT EXISTS calendars (
                    feed_key TEXT NOT NULL REFERENCES feeds(feed_key),
                    service_id TEXT NOT NULL,
                    record TEXT NOT NULL,
                    PRIMARY KEY (feed_key, service_id)
                ) STRICT;
                CREATE TABLE IF NOT EXISTS calendar_dates (
                    feed_key TEXT NOT NULL REFERENCES feeds(feed_key),
                    service_id TEXT NOT NULL,
                    date TEXT NOT NULL,
                    record TEXT NOT NULL,
                    PRIMARY KEY (feed_key, service_id, date)
                ) STRICT;
                CREATE TABLE IF NOT EXISTS shapes (
                    feed_key TEXT NOT NULL REFERENCES feeds(feed_key),
                    shape_id TEXT NOT NULL,
                    shape_pt_sequence INTEGER NOT NULL,
                    record TEXT NOT NULL,
                    PRIMARY KEY (feed_key, shape_id, shape_pt_sequence)
                ) STRICT;
                CREATE TABLE IF NOT EXISTS frequencies (
                    feed_key TEXT NOT NULL,
                    trip_id TEXT NOT NULL,
                    start_time TEXT NOT NULL,
                    record TEXT NOT NULL,
                    PRIMARY KEY (feed_key, trip_id, start_time),
                    FOREIGN KEY (feed_key, trip_id) REFERENCES trips(feed_key, trip_id)
                ) STRICT;
                CREATE INDEX IF NOT EXISTS trips_by_route ON trips (feed_key, route_id, trip_id);
                CREATE INDEX IF NOT EXISTS trips_by_service ON trips (feed_key, service_id, trip_id);
                CREATE INDEX IF NOT EXISTS stop_times_by_stop ON stop_times (feed_key, stop_id, trip_id, stop_sequence);
                PRAGMA user_version = 1;
                COMMIT;
            `);
    }
    if (version === 0 || version === 1) {
      db.exec(`
                BEGIN IMMEDIATE;
                CREATE TABLE IF NOT EXISTS refresh_attempts (
                    feed_key TEXT PRIMARY KEY,
                    attempt_id TEXT NOT NULL,
                    started_at TEXT NOT NULL,
                    finished_at TEXT,
                    status TEXT NOT NULL CHECK (status IN ('running', 'imported', 'unchanged', 'failed')),
                    error TEXT
                ) STRICT;
                CREATE VIEW IF NOT EXISTS feed_service_ranges AS
                SELECT feed_key, MIN(start_date) AS start_date, MAX(end_date) AS end_date
                FROM (
                    SELECT feed_key, json_extract(record, '$.start_date') AS start_date,
                        json_extract(record, '$.end_date') AS end_date
                    FROM calendars
                    UNION ALL
                    SELECT feed_key, date, date FROM calendar_dates
                    WHERE json_extract(record, '$.exception_type') = 1
                )
                GROUP BY feed_key;
                PRAGMA user_version = 2;
                COMMIT;
            `);
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function listImports(db: DatabaseSync, serviceDate: string) {
  return db
    .prepare(
      `
        WITH keys AS (
            SELECT feed_key FROM feed_imports
            UNION SELECT feed_key FROM refresh_attempts
        )
        SELECT keys.feed_key AS agency_key, feeds.imported_at,
            service.start_date AS service_start_date,
            service.end_date AS service_end_date,
            CASE
                WHEN service.end_date IS NULL THEN 'unknown'
                WHEN service.end_date < ? THEN 'expired'
                WHEN service.start_date > ? THEN 'upcoming'
                ELSE 'in_range'
            END AS schedule_status,
            attempt.started_at AS refresh_started_at,
            attempt.finished_at AS refresh_finished_at,
            attempt.status AS refresh_status,
            attempt.error AS refresh_error
        FROM keys
        LEFT JOIN feeds USING (feed_key)
        LEFT JOIN feed_service_ranges AS service USING (feed_key)
        LEFT JOIN refresh_attempts AS attempt USING (feed_key)
        ORDER BY keys.feed_key
    `,
    )
    .all(serviceDate, serviceDate);
}

export function hasFeed(db: DatabaseSync, feedKey: string) {
  return (
    db
      .prepare(
        `
        SELECT 1 FROM feed_imports WHERE feed_key = ?
        UNION ALL SELECT 1 FROM refresh_attempts WHERE feed_key = ?
        LIMIT 1
    `,
      )
      .get(feedKey, feedKey) !== undefined
  );
}

export function serviceEndDate(db: DatabaseSync, feedKey: string) {
  return db
    .prepare("SELECT end_date FROM feed_service_ranges WHERE feed_key = ?")
    .get(feedKey)?.end_date;
}

export function startRefresh(db: DatabaseSync, feedKey: string) {
  const id = randomUUID();
  db.prepare(
    `
        INSERT INTO refresh_attempts (feed_key, attempt_id, started_at, status)
        VALUES (?, ?, ?, 'running')
        ON CONFLICT (feed_key) DO UPDATE SET attempt_id = excluded.attempt_id,
            started_at = excluded.started_at, status = 'running', finished_at = NULL, error = NULL
    `,
  ).run(feedKey, id, new Date().toISOString());
  return id;
}

export function finishRefresh(
  db: DatabaseSync,
  feedKey: string,
  attemptId: string,
  status: "imported" | "unchanged" | "failed",
  error: string | null = null,
) {
  db.prepare(
    `
        UPDATE refresh_attempts SET status = ?, finished_at = ?, error = ?
        WHERE feed_key = ? AND attempt_id = ?
    `,
  ).run(
    status,
    new Date().toISOString(),
    error?.slice(0, 500) ?? null,
    feedKey,
    attemptId,
  );
}

export function currentDigest(db: DatabaseSync, feedKey: string) {
  return db
    .prepare("SELECT digest FROM feed_imports WHERE feed_key = ?")
    .get(feedKey)?.digest;
}

export async function replaceFeed(
  db: DatabaseSync,
  feedKey: string,
  digest: string,
  expectedDigest: ReturnType<typeof currentDigest>,
  writeRows: () => Promise<Partial<Record<Resource, number>>>,
) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = currentDigest(db, feedKey);
    if (current === digest) {
      db.exec("ROLLBACK");
      return { changed: false } as const;
    }
    if (current !== expectedDigest) {
      throw new Error(
        "Another refresh published this feed. Retry against the latest snapshot.",
      );
    }

    db.prepare(
      `
            INSERT INTO feeds (feed_key, imported_at) VALUES (?, ?)
            ON CONFLICT (feed_key) DO UPDATE SET imported_at = excluded.imported_at
        `,
    ).run(feedKey, new Date().toISOString());

    for (const resource of [
      "stop-times",
      "frequencies",
      "trips",
      "stops",
      "routes",
      "agencies",
      "calendars",
      "calendar-dates",
      "shapes",
    ] as const) {
      db.prepare(`DELETE FROM ${tableName(resource)} WHERE feed_key = ?`).run(
        feedKey,
      );
    }
    const counts = await writeRows();
    db.prepare(
      `
            INSERT INTO feed_imports (feed_key, digest) VALUES (?, ?)
            ON CONFLICT (feed_key) DO UPDATE SET digest = excluded.digest
        `,
    ).run(feedKey, digest);
    db.exec("COMMIT");
    return { changed: true, counts } as const;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

type QueryValue = string | number;
type Filters = Record<string, QueryValue>;
export type TransitRecord = Record<string, QueryValue>;
interface Nearby {
  lat: number;
  lon: number;
  radius: number;
}

function readRecord(row: Record<string, unknown>): TransitRecord {
  return { ...JSON.parse(String(row.record)), agency_key: row.feed_key };
}

const stopLatitude = "json_extract(item.record, '$.stop_lat')";
const stopLongitude = "json_extract(item.record, '$.stop_lon')";
// Haversine of the great-circle angle, with the search position in a bound parameter.
const stopDistance = `pow(sin(radians(${stopLatitude} - ?) / 2), 2)
  + cos(radians(?)) * cos(radians(${stopLatitude})) * pow(sin(radians(${stopLongitude} - ?) / 2), 2)`;

export function queryNearbyStops(
  db: DatabaseSync,
  nearby: Nearby,
  limit: number,
  offset: number,
) {
  return db
    .prepare(
      `
    SELECT item.feed_key, item.record, (${stopDistance}) AS distance
    FROM stops AS item
    WHERE ${stopLatitude} BETWEEN -90 AND 90
      AND ${stopLongitude} BETWEEN -180 AND 180
      AND COALESCE(NULLIF(item.record ->> '$.location_type', ''), 0) IN (0, 4)
      AND distance <= ?
    ORDER BY distance, item.feed_key, item.stop_id
    LIMIT ? OFFSET ?
  `,
    )
    .all(
      nearby.lat,
      nearby.lat,
      nearby.lon,
      Math.sin(nearby.radius / (2 * 6371)) ** 2,
      limit,
      offset,
    )
    .map((row) => ({
      stop: readRecord(row),
      distanceMeters: Math.round(
        2 * 6_371_000 * Math.asin(Math.sqrt(Number(row.distance))),
      ),
    }));
}

// HeadSigns of the trips that call at a stop, grouped by route. Some operators
// (for example CP) encode each direction as its own route with the same public
// name, so the destination is what tells them apart.
export function queryStopRouteHeadsigns(
  db: DatabaseSync,
  feedKey: string,
  stopId: string,
) {
  const rows = db
    .prepare(
      `
        SELECT DISTINCT trip.route_id AS routeId,
          COALESCE(NULLIF(times.record ->> '$.stop_headsign', ''),
            NULLIF(trip.record ->> '$.trip_headsign', '')) AS headsign
        FROM stop_times AS times
        JOIN trips AS trip
          ON trip.feed_key = times.feed_key AND trip.trip_id = times.trip_id
        WHERE times.feed_key = ? AND times.stop_id = ?
        ORDER BY trip.route_id, headsign
      `,
    )
    .all(feedKey, stopId) as { routeId: string; headsign: string | null }[];
  const result = new Map<string, string[]>();
  for (const { routeId, headsign } of rows) {
    if (!headsign) continue;
    const list = result.get(routeId) ?? [];
    if (!list.includes(headsign)) list.push(headsign);
    result.set(routeId, list);
  }
  return result;
}

// Every route that calls at a stop, regardless of the current time window, so
// the explorer can show the whole network rather than only active departures.
export function queryStopRoutes(
  db: DatabaseSync,
  feedKey: string,
  stopId: string,
  limit: number,
  offset: number,
) {
  return db
    .prepare(
      `
        SELECT route.feed_key, route.record
        FROM stop_times AS times
        JOIN trips AS trip
          ON trip.feed_key = times.feed_key AND trip.trip_id = times.trip_id
        JOIN routes AS route
          ON route.feed_key = trip.feed_key AND route.route_id = trip.route_id
        WHERE times.feed_key = ? AND times.stop_id = ?
        GROUP BY route.feed_key, route.route_id
        ORDER BY route.route_id
        LIMIT ? OFFSET ?
      `,
    )
    .all(feedKey, stopId, limit, offset)
    .map(readRecord);
}

function likePattern(query: string) {
  return `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

// Cross-feed stop lookup by name or code, mirroring the boardable-stop filter
// used by nearby search. Prefix matches sort first, then feed and stop ID.
export function querySearchStops(
  db: DatabaseSync,
  query: string,
  limit: number,
  offset: number,
) {
  const contains = likePattern(query);
  const prefix = `${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
  return db
    .prepare(
      `
        SELECT item.feed_key, item.record
        FROM stops AS item
        WHERE COALESCE(NULLIF(item.record ->> '$.location_type', ''), 0) IN (0, 4)
          AND (item.record ->> '$.stop_name' LIKE ? ESCAPE '\\'
            OR item.record ->> '$.stop_code' LIKE ? ESCAPE '\\')
        ORDER BY
          CASE WHEN item.record ->> '$.stop_name' LIKE ? ESCAPE '\\'
            THEN 0 ELSE 1 END,
          item.feed_key, item.stop_id
        LIMIT ? OFFSET ?
      `,
    )
    .all(contains, contains, prefix, limit, offset)
    .map(readRecord);
}

export function queryTransit(
  db: DatabaseSync,
  resource: Resource,
  filters: Filters,
  limit: number,
  offset: number,
) {
  const spec = resources[resource];
  const clauses: string[] = [];
  const values: QueryValue[] = [];
  for (const filter of ["agency_key", ...spec.filters]) {
    const value = filters[filter];
    if (value !== undefined) {
      const column = filter === "agency_key" ? "feed_key" : filter;
      clauses.push(`item.${column} = ?`);
      values.push(value);
    }
  }

  const tripClauses: string[] = [];
  const tripValues: QueryValue[] = [];
  for (const column of relatedFilters[resource] || []) {
    if (filters[column] !== undefined) {
      tripClauses.push(`trip.${column} = ?`);
      tripValues.push(filters[column]);
    }
  }
  if (tripClauses.length) {
    const conditions = tripClauses.join(" AND ");
    if (resource === "stops") {
      clauses.push(`(item.feed_key, item.stop_id) IN (
                SELECT times.feed_key, times.stop_id
                FROM trips AS trip
                JOIN stop_times AS times USING (feed_key, trip_id)
                WHERE ${conditions}
                ${
                  filters.agency_key === undefined
                    ? ""
                    : "AND trip.feed_key = ?"
                }
            )`);
    } else {
      const key = resource === "shapes" ? "shape_id" : "trip_id";
      clauses.push(`(item.feed_key, item.${key}) IN (
                SELECT trip.feed_key, trip.${key} FROM trips AS trip
                WHERE ${conditions}
                ${
                  filters.agency_key === undefined
                    ? ""
                    : "AND trip.feed_key = ?"
                }
            )`);
    }
    values.push(...tripValues);
    if (filters.agency_key !== undefined) {
      values.push(filters.agency_key);
    }
  }

  const serviceDate = filters.service_date;
  if (
    typeof serviceDate === "string" &&
    (resource === "trips" || resource === "stop-times")
  ) {
    const isoDate = `${serviceDate.slice(0, 4)}-${serviceDate.slice(4, 6)}-${serviceDate.slice(6)}`;
    const weekday = [
      "sunday",
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
    ][new Date(isoDate).getUTCDay()];
    const service =
      resource === "trips"
        ? "item.service_id"
        : "(SELECT trip.service_id FROM trips AS trip WHERE trip.feed_key = item.feed_key AND trip.trip_id = item.trip_id)";
    clauses.push(`COALESCE(
      (SELECT json_extract(exception.record, '$.exception_type') = 1
       FROM calendar_dates AS exception
       WHERE exception.feed_key = item.feed_key AND exception.service_id = ${service} AND exception.date = ?),
      (SELECT json_extract(calendar.record, '$.${weekday}') = 1
       FROM calendars AS calendar
       WHERE calendar.feed_key = item.feed_key AND calendar.service_id = ${service}
         AND ? BETWEEN json_extract(calendar.record, '$.start_date') AND json_extract(calendar.record, '$.end_date')),
      0
    )`);
    values.push(serviceDate, serviceDate);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const table = tableName(resource);
  if (resource === "shapes") {
    const points = db
      .prepare(
        `
            WITH selected AS (
                SELECT DISTINCT item.feed_key, item.shape_id FROM shapes AS item ${where}
                ORDER BY item.feed_key, item.shape_id LIMIT ? OFFSET ?
            )
            SELECT shapes.feed_key, shapes.record FROM shapes JOIN selected USING (feed_key, shape_id)
            ORDER BY shapes.feed_key, shapes.shape_id, shapes.shape_pt_sequence
        `,
      )
      .iterate(...values, limit, offset);
    const groups: TransitRecord[][] = [];
    let previous: TransitRecord | undefined;
    for (const point of points) {
      const current = readRecord(point);
      if (
        !previous ||
        current.shape_id !== previous.shape_id ||
        current.agency_key !== previous.agency_key
      ) {
        groups.push([]);
      }
      groups[groups.length - 1].push(current);
      previous = current;
    }
    return groups;
  }

  return db
    .prepare(
      `
        SELECT item.feed_key, item.record FROM ${table} AS item ${where}
        ORDER BY item.feed_key, ${spec.key
          .map((column) => `item.${column}`)
          .join(", ")} LIMIT ? OFFSET ?
    `,
    )
    .all(...values, limit, offset)
    .map(readRecord);
}
