type Schema = Record<string, unknown>;

const string = { type: "string" };
const integer = { type: "integer" };
const number = { type: "number" };
const date = { type: "string", format: "date" };
const timestamp = { type: "string", format: "date-time" };
const time = {
  type: "string",
  description: "Time relative to the GTFS service day. Hours can exceed 23.",
  examples: ["14:05:00", "25:10:00"],
};
const nullable = (schema: Schema) => ({ anyOf: [schema, { type: "null" }] });
const array = (items: Schema) => ({ type: "array", items });
const object = (properties: Record<string, Schema>) => ({
  type: "object",
  required: Object.keys(properties),
  properties,
});
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

const optionalText = nullable(string);
const optionalInteger = nullable(integer);
const optionalDate = nullable(date);
const optionalTime = nullable(time);
const optionalTimestamp = nullable(timestamp);

const schemas = {
  Feed: object({
    key: string,
    importedAt: optionalTimestamp,
    schedule: object({
      startDate: optionalDate,
      endDate: optionalDate,
      status: { enum: ["in_range", "upcoming", "expired", "unknown"] },
    }),
    latestRefresh: nullable(
      object({
        status: { enum: ["running", "imported", "unchanged", "failed"] },
        startedAt: timestamp,
        finishedAt: optionalTimestamp,
        error: optionalText,
      }),
    ),
  }),
  Source: object({
    key: string,
    name: string,
    region: string,
    mode: string,
    sourceUrl: string,
    feed: nullable(ref("Feed")),
  }),
  Agency: object({
    id: optionalText,
    name: optionalText,
    url: optionalText,
    timezone: optionalText,
    language: optionalText,
  }),
  Route: object({
    id: string,
    agencyId: optionalText,
    shortName: optionalText,
    longName: optionalText,
    description: optionalText,
    type: optionalInteger,
    url: optionalText,
    color: optionalText,
    textColor: optionalText,
  }),
  Stop: object({
    id: string,
    code: optionalText,
    name: optionalText,
    description: optionalText,
    latitude: nullable(number),
    longitude: nullable(number),
    parentStopId: optionalText,
    locationType: optionalInteger,
    wheelchairBoarding: optionalInteger,
  }),
  NearbyStop: {
    allOf: [ref("Stop"), object({ feedKey: string, distanceMeters: integer })],
  },
  Departure: object({
    kind: { enum: ["scheduled", "headway"] },
    serviceDate: date,
    departureAt: optionalTimestamp,
    windowStartsAt: optionalTimestamp,
    windowEndsAt: optionalTimestamp,
    headwaySeconds: optionalInteger,
    tripId: string,
    routeId: string,
    routeShortName: optionalText,
    routeLongName: optionalText,
    headsign: optionalText,
    stopSequence: integer,
    pickupType: integer,
    approximate: { type: "boolean" },
  }),
  SourceHealth: object({
    status: { enum: ["ok", "attention"] },
    data: array(object({ key: string, name: string, alerts: array(string) })),
  }),
  Trip: object({
    id: string,
    routeId: string,
    serviceId: string,
    headsign: optionalText,
    shortName: optionalText,
    directionId: optionalInteger,
    shapeId: optionalText,
    wheelchairAccessible: optionalInteger,
  }),
  StopTime: object({
    tripId: string,
    stopId: string,
    sequence: integer,
    arrivalTime: optionalTime,
    departureTime: optionalTime,
    headsign: optionalText,
    pickupType: optionalInteger,
    dropOffType: optionalInteger,
  }),
  Calendar: object({
    serviceId: string,
    startDate: optionalDate,
    endDate: optionalDate,
    monday: optionalInteger,
    tuesday: optionalInteger,
    wednesday: optionalInteger,
    thursday: optionalInteger,
    friday: optionalInteger,
    saturday: optionalInteger,
    sunday: optionalInteger,
  }),
  CalendarDate: object({
    serviceId: string,
    date,
    exceptionType: optionalInteger,
  }),
  Shape: object({
    id: string,
    points: array(
      object({ sequence: integer, latitude: number, longitude: number }),
    ),
  }),
  Frequency: object({
    tripId: string,
    startTime: time,
    endTime: optionalTime,
    headwaySeconds: optionalInteger,
    exactTimes: optionalInteger,
  }),
  Pagination: object({
    limit: integer,
    offset: integer,
    nextOffset: {
      ...nullable(integer),
      description:
        "Offset for the next page. Null means there are no more results.",
    },
  }),
  Error: object({ error: object({ code: string, message: string }) }),
};

function pathParameter(name: string, description: string, example: string) {
  return {
    name,
    in: "path",
    required: true,
    description,
    schema: string,
    example,
  };
}

function queryParameter(
  name: string,
  description: string,
  schema: Schema = string,
) {
  return { name, in: "query", description, schema };
}

const feed = pathParameter("feedKey", "Feed key from List feeds.", "carris");
const route = pathParameter("routeId", "Route ID within this feed.", "100_0");
const stop = pathParameter("stopId", "Stop ID within this feed.", "79125");
const trip = pathParameter(
  "tripId",
  "Trip ID within this feed.",
  "17051_20260606_100_0_10",
);
const shape = pathParameter(
  "shapeId",
  "Shape ID within this feed.",
  "100_0_DESC_shp",
);

const routeFilter = queryParameter("routeId", "Only records for this route.");
const tripFilter = queryParameter("tripId", "Only records for this trip.");
const stopFilter = queryParameter("stopId", "Only records for this stop.");
const agencyFilter = queryParameter("agencyId", "Only routes for this agency.");
const serviceFilter = queryParameter(
  "serviceId",
  "Only records for this service calendar.",
);
const directionFilter = queryParameter("directionId", "GTFS direction ID.", {
  type: "integer",
  enum: [0, 1],
});
const dateFilter = queryParameter(
  "date",
  "Only exceptions for this service date.",
  date,
);

const pagination = [
  queryParameter("limit", "Maximum records to return.", {
    type: "integer",
    minimum: 1,
    maximum: 200,
    default: 50,
  }),
  queryParameter("offset", "Number of records to skip.", {
    type: "integer",
    minimum: 0,
    default: 0,
  }),
];

function jsonResponse(description: string, schema: Schema) {
  return { description, content: { "application/json": { schema } } };
}

const serviceDateFilter = {
  name: "serviceDate",
  in: "query",
  description:
    "GTFS service date in YYYY-MM-DD. Applies the weekly calendar and any date exceptions. After-midnight times still belong to their original service date.",
  schema: date,
  example: "2026-11-20",
};

function operation(
  tag: string,
  operationId: string,
  summary: string,
  schemaName: keyof typeof schemas,
  parameters: object[],
  collection = true,
) {
  const item = ref(schemaName);
  const response = collection
    ? object({ data: array(item), pagination: ref("Pagination") })
    : object({ data: item });
  return {
    get: {
      tags: [tag],
      operationId,
      summary,
      parameters: collection ? [...parameters, ...pagination] : parameters,
      responses: {
        200: jsonResponse("Successful response.", response),
        ...(collection
          ? { 400: jsonResponse("Invalid query parameters.", ref("Error")) }
          : {}),
        ...(parameters.some(
          (parameter) => "in" in parameter && parameter.in === "path",
        )
          ? { 404: jsonResponse("Feed or resource not found.", ref("Error")) }
          : {}),
        500: jsonResponse("Could not load transit data.", ref("Error")),
      },
    },
  };
}

const location = (
  name: string,
  description: string,
  min: number,
  max: number,
  example: number,
) => ({
  ...queryParameter(name, description, {
    type: "number",
    minimum: min,
    maximum: max,
  }),
  required: true,
  example,
});
const scope = "/feeds/{feedKey}";

export const openapi = {
  openapi: "3.1.0",
  info: {
    title: "Transportes Portugal API",
    version: "2",
    description:
      "Read Portuguese public transport schedules. Start with **List configured GTFS sources and local status** or **List feeds**, then try **List routes** and **List trips for a route**. In demo mode use feed key demo, route ID r1, and service date 2026-11-20. Use **Try it out** to run a request and copy its curl command. IDs are scoped to a feed. Example IDs come from Carris and may change when the operator publishes a new schedule. This API serves scheduled times.",
  },
  servers: [{ url: "/api/v2" }],
  tags: [
    "Feeds",
    "Routes and agencies",
    "Stops",
    "Trips and times",
    "Calendars and shapes",
  ].map((name) => ({ name })),
  paths: {
    "/nearby-stops": operation(
      "Stops",
      "nearbyStops",
      "Find nearby stops across all feeds",
      "NearbyStop",
      [
        location("lat", "WGS84 latitude.", -90, 90, 38.71),
        location("lon", "WGS84 longitude.", -180, 180, -9.15),
        queryParameter("radius", "Search radius in kilometres.", {
          type: "number",
          exclusiveMinimum: 0,
          maximum: 25,
          default: 1,
        }),
      ],
    ),
    "/source-health": {
      get: {
        tags: ["Feeds"],
        operationId: "sourceHealth",
        summary: "Check configured feeds for refresh and coverage alerts",
        responses: {
          200: jsonResponse(
            "Configured feeds are healthy.",
            ref("SourceHealth"),
          ),
          503: jsonResponse(
            "One or more feeds need attention.",
            ref("SourceHealth"),
          ),
        },
      },
    },
    "/sources": operation(
      "Feeds",
      "listSources",
      "List configured GTFS sources and local status",
      "Source",
      [],
    ),
    "/feeds": operation("Feeds", "listFeeds", "List feeds", "Feed", []),
    [scope]: operation(
      "Feeds",
      "getFeed",
      "Get feed and freshness",
      "Feed",
      [feed],
      false,
    ),
    [`${scope}/agencies`]: operation(
      "Routes and agencies",
      "listAgencies",
      "List agencies",
      "Agency",
      [feed],
    ),
    [`${scope}/routes`]: operation(
      "Routes and agencies",
      "listRoutes",
      "List routes",
      "Route",
      [feed, agencyFilter],
    ),
    [`${scope}/routes/{routeId}`]: operation(
      "Routes and agencies",
      "getRoute",
      "Get a route",
      "Route",
      [feed, route],
      false,
    ),
    [`${scope}/routes/{routeId}/trips`]: operation(
      "Trips and times",
      "listRouteTrips",
      "List trips for a route",
      "Trip",
      [feed, route, serviceFilter, directionFilter, serviceDateFilter],
    ),
    [`${scope}/stops`]: operation("Stops", "listStops", "List stops", "Stop", [
      feed,
      routeFilter,
      tripFilter,
    ]),
    [`${scope}/stops/{stopId}`]: operation(
      "Stops",
      "getStop",
      "Get a stop",
      "Stop",
      [feed, stop],
      false,
    ),
    [`${scope}/stops/{stopId}/departures`]: {
      get: {
        tags: ["Stops"],
        operationId: "listDepartures",
        summary:
          "Find upcoming scheduled departures and headway windows at a stop",
        parameters: [
          feed,
          stop,
          queryParameter(
            "from",
            "ISO timestamp with UTC offset. Defaults to the current instant.",
            timestamp,
          ),
          queryParameter("minutes", "Window length in minutes.", {
            type: "integer",
            minimum: 1,
            maximum: 1440,
            default: 120,
          }),
          pagination[0],
        ],
        responses: {
          200: jsonResponse(
            "Schedules in chronological order with local UTC offsets and feed freshness.",
            object({
              data: array(ref("Departure")),
              from: timestamp,
              until: timestamp,
              feed: ref("Feed"),
            }),
          ),
          400: jsonResponse("Invalid query parameters.", ref("Error")),
          404: jsonResponse("Feed or stop not found.", ref("Error")),
          500: jsonResponse("Could not load transit data.", ref("Error")),
        },
      },
    },
    [`${scope}/stops/{stopId}/stop-times`]: operation(
      "Stops",
      "listStopTimesForStop",
      "List scheduled times at a stop",
      "StopTime",
      [feed, stop, tripFilter, serviceDateFilter],
    ),
    [`${scope}/trips`]: operation(
      "Trips and times",
      "listTrips",
      "List trips",
      "Trip",
      [feed, routeFilter, serviceFilter, directionFilter, serviceDateFilter],
    ),
    [`${scope}/trips/{tripId}`]: operation(
      "Trips and times",
      "getTrip",
      "Get a trip",
      "Trip",
      [feed, trip],
      false,
    ),
    [`${scope}/trips/{tripId}/stop-times`]: operation(
      "Trips and times",
      "listTripStopTimes",
      "List stop times for a trip",
      "StopTime",
      [feed, trip, stopFilter],
    ),
    [`${scope}/trips/{tripId}/frequencies`]: operation(
      "Trips and times",
      "listTripFrequencies",
      "List frequency windows for a trip",
      "Frequency",
      [feed, trip],
    ),
    [`${scope}/calendars`]: operation(
      "Calendars and shapes",
      "listCalendars",
      "List weekly service calendars",
      "Calendar",
      [feed, serviceFilter],
    ),
    [`${scope}/calendar-dates`]: operation(
      "Calendars and shapes",
      "listCalendarDates",
      "List service calendar exceptions",
      "CalendarDate",
      [feed, serviceFilter, dateFilter],
    ),
    [`${scope}/shapes`]: operation(
      "Calendars and shapes",
      "listShapes",
      "List route shapes",
      "Shape",
      [feed, routeFilter, tripFilter],
    ),
    [`${scope}/shapes/{shapeId}`]: operation(
      "Calendars and shapes",
      "getShape",
      "Get a shape",
      "Shape",
      [feed, shape],
      false,
    ),
  },
  components: { schemas },
};
