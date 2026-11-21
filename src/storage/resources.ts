export const resources = {
  agencies: {
    file: "agency.txt",
    key: ["agency_id"],
    filters: ["agency_id"],
  },
  routes: {
    file: "routes.txt",
    key: ["route_id"],
    filters: ["agency_id", "route_id"],
  },
  stops: { file: "stops.txt", key: ["stop_id"], filters: ["stop_id"] },
  trips: {
    file: "trips.txt",
    key: ["trip_id"],
    filters: ["trip_id", "route_id", "service_id", "direction_id", "shape_id"],
  },
  "stop-times": {
    file: "stop_times.txt",
    key: ["trip_id", "stop_sequence"],
    filters: ["trip_id", "stop_id", "stop_sequence"],
  },
  calendars: {
    file: "calendar.txt",
    key: ["service_id"],
    filters: ["service_id"],
  },
  "calendar-dates": {
    file: "calendar_dates.txt",
    key: ["service_id", "date"],
    filters: ["service_id", "date"],
  },
  shapes: {
    file: "shapes.txt",
    key: ["shape_id", "shape_pt_sequence"],
    filters: ["shape_id"],
  },
  frequencies: {
    file: "frequencies.txt",
    key: ["trip_id", "start_time"],
    filters: ["trip_id"],
  },
} as const;

export type Resource = keyof typeof resources;

export const relatedFilters: Partial<Record<Resource, readonly string[]>> = {
  stops: ["route_id", "trip_id", "direction_id", "service_id"],
  "stop-times": ["route_id", "direction_id", "service_id"],
  shapes: ["route_id", "trip_id", "direction_id", "service_id"],
};

export const tableName = (resource: Resource) => resource.replaceAll("-", "_");
