import type { DatabaseSync } from "node:sqlite";
import type { TransitRecord } from "./sqlite";

type StopTimeRow = {
  tripId: string;
  routeId: string;
  stopSequence: number;
  departure: string | null;
  firstDeparture: string | null;
  headsign: string | null;
  routeShortName: string | null;
  routeLongName: string | null;
  timezone: string;
  pickupType: number;
  timepoint: number;
  calendar: string | null;
  exceptions: string;
  frequencies: string;
};

function timeSeconds(value: unknown) {
  if (typeof value !== "string" || !/^\d{1,3}:[0-5]\d:[0-5]\d$/.test(value)) {
    return undefined;
  }
  const [hours, minutes, seconds] = value.split(":").map(Number);
  return hours * 3600 + minutes * 60 + seconds;
}

const weekdays = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

type Event = {
  kind: "scheduled" | "headway";
  serviceDate: string;
  departureAt: string | null;
  windowStartsAt: string | null;
  windowEndsAt: string | null;
  headwaySeconds: number | null;
  tripId: string;
  routeId: string;
  routeShortName: string | null;
  routeLongName: string | null;
  headsign: string | null;
  stopSequence: number;
  pickupType: number;
  approximate: boolean;
};
type TimedEvent = { at: number; event: Event };
type Summary = {
  first: TimedEvent | null;
  last: TimedEvent | null;
  next: TimedEvent | null;
};

export function queryDepartures(
  db: DatabaseSync,
  feedKey: string,
  stopId: string,
  from: Temporal.Instant,
  minutes: number,
  limit: number,
  routeId?: string,
) {
  return collectDepartures(db, feedKey, stopId, from, minutes, limit, routeId);
}

export function queryPatternSchedule(
  db: DatabaseSync,
  feedKey: string,
  routeId: string,
  patternId: string,
  stopId: string,
  from: Temporal.Instant,
) {
  const summary: Summary = { first: null, last: null, next: null };
  collectDepartures(db, feedKey, stopId, from, 0, 0, routeId, {
    patternId,
    summary,
  });
  return {
    first: summary.first?.event ?? null,
    last: summary.last?.event ?? null,
    next: summary.next?.event ?? null,
  };
}

function collectDepartures(
  db: DatabaseSync,
  feedKey: string,
  stopId: string,
  from: Temporal.Instant,
  minutes: number,
  limit: number,
  routeId?: string,
  pattern?: { patternId: string; summary: Summary },
) {
  const patternFilter = pattern
    ? `AND trip.shape_id IS ? AND trip.direction_id IS ?
      AND COALESCE(trip.record ->> '$.trip_headsign', '') = ?
      AND item.stop_sequence = (SELECT MIN(stop_sequence) FROM stop_times
        WHERE feed_key = trip.feed_key AND trip_id = trip.trip_id)`
    : "";
  const routeFilter = routeId ? "AND trip.route_id = ?" : "";
  const rows = db
    .prepare(
      `
    SELECT trip.trip_id AS tripId, trip.route_id AS routeId,
      item.stop_sequence AS stopSequence,
      item.record ->> '$.departure_time' AS departure,
      (SELECT first.record ->> '$.departure_time' FROM stop_times AS first
        WHERE first.feed_key = trip.feed_key AND first.trip_id = trip.trip_id
        ORDER BY first.stop_sequence LIMIT 1) AS firstDeparture,
      COALESCE(NULLIF(item.record ->> '$.stop_headsign', ''),
               NULLIF(trip.record ->> '$.trip_headsign', '')) AS headsign,
      NULLIF(route.record ->> '$.route_short_name', '') AS routeShortName,
      NULLIF(route.record ->> '$.route_long_name', '') AS routeLongName,
      agency.record ->> '$.agency_timezone' AS timezone,
      COALESCE(NULLIF(item.record ->> '$.pickup_type', ''), 0) AS pickupType,
      COALESCE(NULLIF(item.record ->> '$.timepoint', ''), 1) AS timepoint,
      calendar.record AS calendar,
      (SELECT json_group_object(exception.date, exception.record ->> '$.exception_type')
       FROM calendar_dates AS exception WHERE exception.feed_key = trip.feed_key
         AND exception.service_id = trip.service_id) AS exceptions,
      (SELECT json_group_array(json(frequency.record)) FROM frequencies AS frequency
       WHERE frequency.feed_key = trip.feed_key AND frequency.trip_id = trip.trip_id) AS frequencies
    -- Always drive from the stop's rows. Without this hint, adding a
    -- route filter makes SQLite scan every stop_time in the feed.
    FROM stop_times AS item INDEXED BY stop_times_by_stop
    JOIN trips AS trip USING (feed_key, trip_id)
    JOIN routes AS route ON route.feed_key = trip.feed_key AND route.route_id = trip.route_id
    JOIN agencies AS agency ON agency.feed_key = route.feed_key AND agency.agency_id = route.agency_id
    LEFT JOIN calendars AS calendar ON calendar.feed_key = trip.feed_key AND calendar.service_id = trip.service_id
    WHERE item.feed_key = ? AND item.stop_id = ?
      AND item.record ->> '$.pickup_type' IS NOT 1
      ${routeFilter}
      ${patternFilter}
    ORDER BY trip.trip_id, item.stop_sequence
  `,
    )
    .iterate(
      feedKey,
      stopId,
      ...(routeId ? [routeId] : []),
      ...(pattern
        ? (JSON.parse(pattern.patternId) as [
            string | null,
            number | null,
            string,
          ])
        : []),
    );

  const startMs = from.epochMilliseconds;
  const endMs = startMs + minutes * 60_000;
  type ServiceDay = {
    isoDate: string;
    compact: string;
    weekday: string;
    origin: number;
  };
  type LocalCalendar = {
    date: Temporal.PlainDate;
    days: Map<number, ServiceDay>;
  };
  const timezones = new Map<string, LocalCalendar | null>();
  function resolveDay(local: LocalCalendar, timezone: string, day: number) {
    const cached = local.days.get(day);
    if (cached) return cached;
    const date = local.date.add({ days: day });
    const isoDate = date.toString();
    const value = {
      isoDate,
      compact: isoDate.replaceAll("-", ""),
      weekday: weekdays[date.dayOfWeek - 1],
      origin: date
        .toZonedDateTime({ timeZone: timezone, plainTime: "12:00" })
        .subtract({ hours: 12 }).epochMilliseconds,
    };
    local.days.set(day, value);
    return value;
  }
  const events: TimedEvent[] = [];
  const compare = (a: { at: number }, b: { at: number }) => a.at - b.at;

  for (const result of rows) {
    const row = result as StopTimeRow;
    const departure = timeSeconds(row.departure);
    if (departure === undefined) continue;
    if (!timezones.has(row.timezone)) {
      try {
        timezones.set(row.timezone, {
          date: from.toZonedDateTimeISO(row.timezone).toPlainDate(),
          days: new Map(),
        });
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        timezones.set(row.timezone, null);
      }
    }
    const localFrom = timezones.get(row.timezone);
    if (!localFrom) continue;

    const calendar = JSON.parse(row.calendar ?? "{}") as TransitRecord;
    const exceptions = JSON.parse(row.exceptions) as Record<string, number>;
    const frequencies = JSON.parse(row.frequencies) as TransitRecord[];
    const first = timeSeconds(row.firstDeparture);
    const windows: {
      start: number;
      end: number;
      headway: number;
      exact: boolean;
    }[] = [];
    if (!frequencies.length) {
      windows.push({
        start: departure,
        end: departure + 1,
        headway: 1,
        exact: true,
      });
    } else if (first !== undefined && departure >= first) {
      const offset = departure - first;
      for (const frequency of frequencies) {
        const start = timeSeconds(frequency.start_time);
        const end = timeSeconds(frequency.end_time);
        const headway = Number(frequency.headway_secs);
        if (
          start !== undefined &&
          end !== undefined &&
          end > start &&
          Number.isSafeInteger(headway) &&
          headway > 0
        ) {
          windows.push({
            start: start + offset,
            end: end + offset,
            headway,
            exact: frequency.exact_times === 1,
          });
        }
      }
    }

    const format = (ms: number) =>
      Temporal.Instant.fromEpochMilliseconds(ms)
        .toZonedDateTimeISO(row.timezone)
        .toString({ timeZoneName: "never", smallestUnit: "second" });

    for (const window of windows) {
      if (pattern) {
        const { summary } = pattern;
        const todayStart = localFrom.date.toZonedDateTime(
          row.timezone,
        ).epochMilliseconds;
        const todayEnd = localFrom.date
          .add({ days: 1 })
          .toZonedDateTime(row.timezone).epochMilliseconds;
        const step = window.headway * 1000;
        const scheduledStart = Math.floor(window.start / 86_400);
        const firstDay = -Math.ceil(window.end / 86_400) - 1;
        const dateOffset = (value: unknown) => {
          const compact = String(value);
          if (!/^\d{8}$/.test(compact)) return null;
          try {
            return localFrom.date.until(Temporal.PlainDate.from(compact)).days;
          } catch (error) {
            if (!(error instanceof RangeError)) throw error;
            return null;
          }
        };
        const dates = Object.entries(exceptions)
          .filter(([, value]) => value === 1)
          .flatMap(([date]) => {
            const offset = dateOffset(date);
            return offset === null || offset < firstDay ? [] : [offset];
          });
        const calendarStart = dateOffset(calendar.start_date);
        const calendarEnd = dateOffset(calendar.end_date);
        if (
          calendarStart !== null &&
          calendarEnd !== null &&
          weekdays.some((weekday) => calendar[weekday] === 1)
        ) {
          for (
            let day = Math.max(firstDay, calendarStart);
            day <= calendarEnd;
            day++
          ) {
            const { compact, weekday } = resolveDay(
              localFrom,
              row.timezone,
              day,
            );
            if ((exceptions[compact] ?? Number(calendar[weekday] === 1)) !== 1)
              continue;
            dates.push(day);
            // Once two days beyond today's possible service origins, later
            // calendar dates can no longer contribute to today's or next service.
            if (day > 1 - scheduledStart) break;
          }
        }

        for (const day of dates) {
          const { origin, isoDate } = resolveDay(localFrom, row.timezone, day);
          const start = origin + window.start * 1000;
          const end = origin + window.end * 1000;
          const firstAt = (boundary: number) =>
            window.exact
              ? start + Math.max(0, Math.ceil((boundary - start) / step)) * step
              : Math.max(boundary, start);
          const eventAt = (at: number): TimedEvent => ({
            at,
            event: {
              kind: window.exact ? "scheduled" : "headway",
              serviceDate: isoDate,
              departureAt: window.exact ? format(at) : null,
              windowStartsAt: window.exact ? null : format(start),
              windowEndsAt: window.exact ? null : format(end),
              headwaySeconds: window.exact ? null : window.headway,
              tripId: row.tripId,
              routeId: row.routeId,
              routeShortName: row.routeShortName,
              routeLongName: row.routeLongName,
              headsign: row.headsign,
              stopSequence: row.stopSequence,
              pickupType: row.pickupType,
              approximate: row.timepoint === 0,
            },
          });
          const first = firstAt(todayStart);
          const todayLimit = Math.min(end, todayEnd);
          if (first < todayLimit) {
            const last = window.exact
              ? start + Math.floor((todayLimit - 1 - start) / step) * step
              : todayLimit;
            if (!summary.first || first < summary.first.at)
              summary.first = eventAt(first);
            if (!summary.last || last > summary.last.at)
              summary.last = eventAt(last);
          }
          const next = firstAt(startMs);
          if (next < end && (!summary.next || next < summary.next.at)) {
            summary.next = eventAt(next);
          }
        }
        continue;
      }

      // Allow a day on either side for UTC offsets and daylight-saving transitions.
      const firstDay = -Math.ceil(window.end / 86_400) - 1;
      const lastDay = 2 - Math.floor(window.start / 86_400);
      for (let day = firstDay; day <= lastDay; day++) {
        const { isoDate, compact, weekday, origin } = resolveDay(
          localFrom,
          row.timezone,
          day,
        );
        const active =
          exceptions[compact] ??
          Number(
            compact >= String(calendar.start_date) &&
              compact <= String(calendar.end_date) &&
              calendar[weekday] === 1,
          );
        if (active !== 1) continue;
        const start = origin + window.start * 1000;
        const end = origin + window.end * 1000;
        if (end <= startMs || start >= endMs) continue;
        const details = {
          serviceDate: isoDate,
          tripId: row.tripId,
          routeId: row.routeId,
          routeShortName: row.routeShortName,
          routeLongName: row.routeLongName,
          headsign: row.headsign,
          stopSequence: row.stopSequence,
          pickupType: row.pickupType,
          approximate: row.timepoint === 0,
        };
        if (window.exact) {
          const step = window.headway * 1000;
          let at =
            start + Math.max(0, Math.ceil((startMs - start) / step)) * step;
          for (
            let n = 0;
            n < limit && at < Math.min(end, endMs);
            n++, at += step
          ) {
            events.push({
              at,
              event: {
                ...details,
                kind: "scheduled",
                departureAt: format(at),
                windowStartsAt: null,
                windowEndsAt: null,
                headwaySeconds: null,
              },
            });
          }
        } else {
          events.push({
            at: Math.max(start, startMs),
            event: {
              ...details,
              kind: "headway",
              departureAt: null,
              windowStartsAt: format(start),
              windowEndsAt: format(end),
              headwaySeconds: window.headway,
            },
          });
        }
        if (events.length >= limit * 2) {
          events.sort(compare);
          events.length = limit;
        }
      }
    }
  }
  return events
    .sort(compare)
    .slice(0, limit)
    .map(({ event }) => event);
}
