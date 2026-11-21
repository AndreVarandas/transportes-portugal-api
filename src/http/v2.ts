import { Hono } from "hono";
import type { Context } from "hono";
import type { DatabaseSync } from "node:sqlite";
import type { Resource } from "../storage/resources";
import {
  hasFeed,
  listImports,
  queryTransit,
  queryNearbyStops,
  TransitRecord,
} from "../storage/sqlite";
import { queryDepartures } from "../storage/departures";
import { sourceCoverage } from "../transit/coverage";
import { sources } from "../transit/sources";
import { lisbonToday } from "../transit/service-date";

const fields: Record<Exclude<Resource, "shapes">, Record<string, string>> = {
  agencies: {
    id: "agency_id",
    name: "agency_name",
    url: "agency_url",
    timezone: "agency_timezone",
    language: "agency_lang",
  },
  routes: {
    id: "route_id",
    agencyId: "agency_id",
    shortName: "route_short_name",
    longName: "route_long_name",
    description: "route_desc",
    type: "route_type",
    url: "route_url",
    color: "route_color",
    textColor: "route_text_color",
  },
  stops: {
    id: "stop_id",
    code: "stop_code",
    name: "stop_name",
    description: "stop_desc",
    latitude: "stop_lat",
    longitude: "stop_lon",
    parentStopId: "parent_station",
    locationType: "location_type",
    wheelchairBoarding: "wheelchair_boarding",
  },
  trips: {
    id: "trip_id",
    routeId: "route_id",
    serviceId: "service_id",
    headsign: "trip_headsign",
    shortName: "trip_short_name",
    directionId: "direction_id",
    shapeId: "shape_id",
    wheelchairAccessible: "wheelchair_accessible",
  },
  "stop-times": {
    tripId: "trip_id",
    stopId: "stop_id",
    sequence: "stop_sequence",
    arrivalTime: "arrival_time",
    departureTime: "departure_time",
    headsign: "stop_headsign",
    pickupType: "pickup_type",
    dropOffType: "drop_off_type",
  },
  calendars: {
    serviceId: "service_id",
    startDate: "start_date",
    endDate: "end_date",
    monday: "monday",
    tuesday: "tuesday",
    wednesday: "wednesday",
    thursday: "thursday",
    friday: "friday",
    saturday: "saturday",
    sunday: "sunday",
  },
  "calendar-dates": {
    serviceId: "service_id",
    date: "date",
    exceptionType: "exception_type",
  },
  frequencies: {
    tripId: "trip_id",
    startTime: "start_time",
    endTime: "end_time",
    headwaySeconds: "headway_secs",
    exactTimes: "exact_times",
  },
};

const filters: Partial<Record<Resource, Record<string, string>>> = {
  routes: { agencyId: "agency_id" },
  stops: { routeId: "route_id", tripId: "trip_id" },
  trips: {
    routeId: "route_id",
    serviceId: "service_id",
    serviceDate: "service_date",
    directionId: "direction_id",
  },
  "stop-times": { stopId: "stop_id" },
  calendars: { serviceId: "service_id" },
  "calendar-dates": { serviceId: "service_id", date: "date" },
  shapes: { routeId: "route_id", tripId: "trip_id" },
};

function date(value: unknown) {
  return typeof value === "string" && /^\d{8}$/.test(value)
    ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}`
    : null;
}

function normalize(resource: Resource, row: TransitRecord | TransitRecord[]) {
  if (Array.isArray(row)) {
    return {
      id: row[0].shape_id,
      points: row.map((point) => ({
        sequence: point.shape_pt_sequence,
        latitude: point.shape_pt_lat,
        longitude: point.shape_pt_lon,
      })),
    };
  }
  if (resource === "shapes") {
    throw new Error("Expected a group of shape points.");
  }
  return Object.fromEntries(
    Object.entries(fields[resource]).map(([key, column]) => {
      const value = row[column];
      return [
        key,
        ["date", "startDate", "endDate"].includes(key)
          ? date(value)
          : value === ""
            ? null
            : (value ?? null),
      ];
    }),
  );
}

function normalizeFeed(row: ReturnType<typeof listImports>[number]) {
  return {
    key: row.agency_key,
    importedAt: row.imported_at,
    schedule: {
      startDate: date(row.service_start_date),
      endDate: date(row.service_end_date),
      status: row.schedule_status,
    },
    latestRefresh: row.refresh_status
      ? {
          status: row.refresh_status,
          startedAt: row.refresh_started_at,
          finishedAt: row.refresh_finished_at,
          error: row.refresh_error,
        }
      : null,
  };
}

function badQuery(c: Context, message: string) {
  return c.json({ error: { code: "invalid_query", message } }, 400);
}

function notFound(c: Context, resource: string) {
  return c.json(
    { error: { code: "not_found", message: `${resource} not found.` } },
    404,
  );
}

function parseList(
  c: Context,
  allowed: Record<string, string>,
  paginate = true,
) {
  const query = new URL(c.req.url).searchParams;
  for (const key of query.keys()) {
    if (
      (!Object.hasOwn(allowed, key) &&
        key !== "limit" &&
        (key !== "offset" || !paginate)) ||
      query.getAll(key).length !== 1
    ) {
      return badQuery(c, `Unsupported or repeated query parameter: ${key}.`);
    }
  }
  const limitText = query.get("limit") ?? "50";
  const offsetText = query.get("offset") ?? "0";
  const limit = Number(limitText);
  const offset = Number(offsetText);
  if (
    !/^\d+$/.test(limitText) ||
    limit < 1 ||
    limit > 200 ||
    !/^\d+$/.test(offsetText) ||
    !Number.isSafeInteger(offset) ||
    offset > Number.MAX_SAFE_INTEGER - limit
  ) {
    return badQuery(
      c,
      "Use a limit from 1 to 200 and a nonnegative integer offset.",
    );
  }

  const conditions: Record<string, string | number> = {};
  for (const [key, column] of Object.entries(allowed)) {
    const value = query.get(key);
    if (value === null) continue;
    if (
      !value ||
      (key === "directionId" && value !== "0" && value !== "1") ||
      ((key === "date" || key === "serviceDate") &&
        (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
          !Number.isFinite(Date.parse(value)) ||
          new Date(value).toISOString().slice(0, 10) !== value))
    ) {
      return badQuery(c, `Invalid value for ${key}.`);
    }
    conditions[column] =
      key === "directionId"
        ? Number(value)
        : key === "date" || key === "serviceDate"
          ? value.replaceAll("-", "")
          : value;
  }
  return { limit, offset, conditions };
}

function decimal(value: unknown) {
  return typeof value === "string" &&
    /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)
    ? Number(value)
    : NaN;
}

function page<T>(rows: T[], limit: number, offset: number) {
  return {
    data: rows.slice(0, limit),
    pagination: {
      limit,
      offset,
      nextOffset: rows.length > limit ? offset + limit : null,
    },
  };
}

const detailKeys = {
  routes: "route_id",
  stops: "stop_id",
  trips: "trip_id",
  shapes: "shape_id",
} as const;
type DetailResource = keyof typeof detailKeys;

export function createV2(db: DatabaseSync) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      c.header("Allow", "GET, HEAD");
      return c.json(
        {
          error: {
            code: "method_not_allowed",
            message: "Use GET to read data.",
          },
        },
        405,
      );
    }
    await next();
  });
  app.get("/nearby-stops", (c) => {
    const input = parseList(c, { lat: "lat", lon: "lon", radius: "radius" });
    if (input instanceof Response) return input;
    const { limit, offset, conditions } = input;
    const lat = decimal(conditions.lat);
    const lon = decimal(conditions.lon);
    const radius =
      conditions.radius === undefined ? 1 : decimal(conditions.radius);
    if (
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180 ||
      !(radius > 0 && radius <= 25) ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lon)
    ) {
      return badQuery(
        c,
        "Use lat from -90 to 90, lon from -180 to 180, and a radius above 0 and up to 25 km.",
      );
    }
    const rows = queryNearbyStops(db, { lat, lon, radius }, limit + 1, offset);
    return c.json(
      page(
        rows.map(({ stop, distanceMeters }) => ({
          ...normalize("stops", stop),
          feedKey: stop.agency_key,
          distanceMeters,
        })),
        limit,
        offset,
      ),
    );
  });

  app.get("/source-health", (c) => {
    if (new URL(c.req.url).searchParams.size)
      return badQuery(c, "This endpoint does not take query parameters.");
    const data = sourceCoverage(db);
    const attention = data.some(({ alerts }) => alerts.length > 0);
    c.header("Cache-Control", "no-store");
    return c.json(
      { data, status: attention ? "attention" : "ok" },
      attention ? 503 : 200,
    );
  });

  app.get("/sources", (c) => {
    const input = parseList(c, {});
    if (input instanceof Response) return input;
    const { limit, offset } = input;
    const snapshots = new Map(
      listImports(db, lisbonToday()).map((row) => [
        row.agency_key,
        normalizeFeed(row),
      ]),
    );
    const rows = [...sources]
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(offset, offset + limit + 1)
      .map(([key, source]) => ({
        key,
        name: source.name,
        region: source.region,
        mode: source.mode,
        sourceUrl: source.url,
        feed: snapshots.get(key) ?? null,
      }));
    return c.json(page(rows, limit, offset));
  });
  app.get("/feeds", (c) => {
    const input = parseList(c, {});
    if (input instanceof Response) return input;
    const { limit, offset } = input;
    const rows = listImports(db, lisbonToday()).slice(
      offset,
      offset + limit + 1,
    );
    return c.json(page(rows.map(normalizeFeed), limit, offset));
  });
  const getFeed = (feedKey: string) =>
    listImports(db, lisbonToday()).find((row) => row.agency_key === feedKey);
  app.get("/feeds/:feedKey", (c) => {
    const feed = getFeed(c.req.param("feedKey"));
    return feed ? c.json({ data: normalizeFeed(feed) }) : notFound(c, "Feed");
  });

  const scope = "/feeds/:feedKey";
  app.get(`${scope}/stops/:stopId/departures`, (c) => {
    const input = parseList(c, { from: "from", minutes: "minutes" }, false);
    if (input instanceof Response) return input;
    const { conditions, limit } = input;
    const minutesText = String(conditions.minutes ?? "120");
    const minutes = Number(minutesText);
    if (!/^\d+$/.test(minutesText) || minutes < 1 || minutes > 1440) {
      return badQuery(c, "Use a window from 1 to 1440 minutes.");
    }
    const fromText = conditions.from;
    let from = Temporal.Instant.fromEpochMilliseconds(Date.now());
    if (typeof fromText === "string") {
      if (
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
          fromText,
        )
      ) {
        return badQuery(
          c,
          "Use an ISO timestamp with a UTC offset or Z for from.",
        );
      }
      try {
        from = Temporal.Instant.from(fromText);
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        return badQuery(c, "Invalid from timestamp.");
      }
    }
    const feedKey = c.req.param("feedKey");
    const stopId = c.req.param("stopId");
    const feed = getFeed(feedKey);
    if (!feed?.imported_at) return notFound(c, "Feed");
    if (
      !queryTransit(db, "stops", { agency_key: feedKey, stop_id: stopId }, 1, 0)
        .length
    ) {
      return notFound(c, "Stop");
    }
    c.header("Cache-Control", "no-store");
    return c.json({
      data: queryDepartures(db, feedKey, stopId, from, minutes, limit),
      from: from.toString(),
      until: from.add({ minutes }).toString(),
      feed: normalizeFeed(feed),
    });
  });

  const list =
    (resource: Resource, parent?: "routes" | "trips" | "stops") =>
    (c: Context) => {
      const feedKey = c.req.param("feedKey");
      if (!feedKey || !hasFeed(db, feedKey)) return notFound(c, "Feed");

      const allowed = { ...filters[resource] };
      if (parent === "routes") delete allowed.routeId;
      if (parent === "stops") {
        delete allowed.stopId;
        allowed.tripId = "trip_id";
        allowed.serviceDate = "service_date";
      }
      const input = parseList(c, allowed);
      if (input instanceof Response) return input;
      const { conditions, limit, offset } = input;
      conditions.agency_key = feedKey;

      if (parent) {
        const parentId = c.req.param("parentId");
        const key = detailKeys[parent];
        if (
          !parentId ||
          !queryTransit(
            db,
            parent,
            { agency_key: feedKey, [key]: parentId },
            1,
            0,
          ).length
        ) {
          return notFound(
            c,
            parent === "routes"
              ? "Route"
              : parent === "trips"
                ? "Trip"
                : "Stop",
          );
        }
        conditions[key] = parentId;
      }
      const rows = queryTransit(db, resource, conditions, limit + 1, offset);
      return c.json(
        page(
          rows.map((row) => normalize(resource, row)),
          limit,
          offset,
        ),
      );
    };
  for (const resource of [
    "agencies",
    "routes",
    "stops",
    "trips",
    "calendars",
    "calendar-dates",
    "shapes",
  ] as const) {
    app.get(`${scope}/${resource}`, list(resource));
  }
  for (const resource of Object.keys(detailKeys) as DetailResource[]) {
    app.get(`${scope}/${resource}/:id`, (c) => {
      const feedKey = c.req.param("feedKey");
      if (!feedKey || !hasFeed(db, feedKey)) return notFound(c, "Feed");
      const [row] = queryTransit(
        db,
        resource,
        {
          agency_key: feedKey,
          [detailKeys[resource]]: c.req.param("id"),
        },
        1,
        0,
      );
      return row
        ? c.json({ data: normalize(resource, row) })
        : notFound(c, "Resource");
    });
  }
  app.get(`${scope}/routes/:parentId/trips`, list("trips", "routes"));
  app.get(`${scope}/trips/:parentId/stop-times`, list("stop-times", "trips"));
  app.get(`${scope}/stops/:parentId/stop-times`, list("stop-times", "stops"));
  app.get(`${scope}/trips/:parentId/frequencies`, list("frequencies", "trips"));
  app.all("*", (c) => notFound(c, "Endpoint"));
  app.onError((error, c) => {
    console.error(error);
    return c.json(
      {
        error: {
          code: "internal_error",
          message: "Could not load transit data.",
        },
      },
      500,
    );
  });
  return app;
}
