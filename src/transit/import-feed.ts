import { parse } from "csv-parse";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { pipeline } from "node:stream/promises";
import { Entry, openPromise } from "yauzl";
import { Resource, resources, tableName } from "../storage/resources";
import { currentDigest, replaceFeed, serviceEndDate } from "../storage/sqlite";

type CsvRow = Record<string, string>;

const importOrder: Resource[] = [
  "agencies",
  "routes",
  "stops",
  "trips",
  "stop-times",
  "calendars",
  "calendar-dates",
  "shapes",
  "frequencies",
];
const required: Resource[] = [
  "agencies",
  "routes",
  "stops",
  "trips",
  "stop-times",
];
const numericFields: ReadonlySet<string> = new Set([
  "route_type",
  "stop_lat",
  "stop_lon",
  "location_type",
  "wheelchair_boarding",
  "direction_id",
  "wheelchair_accessible",
  "bikes_allowed",
  "stop_sequence",
  "pickup_type",
  "drop_off_type",
  "continuous_pickup",
  "continuous_drop_off",
  "shape_dist_traveled",
  "timepoint",
  "exception_type",
  "shape_pt_sequence",
  "shape_pt_lat",
  "shape_pt_lon",
  "headway_secs",
  "exact_times",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
]);
const optionalColumns = new Set(["direction_id", "shape_id"]);

export async function importFeed(
  db: DatabaseSync,
  feedKey: string,
  archive: string,
  expectedDigest: ReturnType<typeof currentDigest>,
  serviceDate?: string,
) {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(feedKey)) {
    throw new Error(
      "Feed keys must contain lowercase letters, digits, hyphens, or underscores.",
    );
  }

  const hash = createHash("sha256");
  for await (const chunk of createReadStream(archive)) {
    hash.update(chunk);
  }
  const digest = hash.digest("hex");

  const ensureCoverage = () => {
    if (!serviceDate) return;

    const coverage = serviceEndDate(db, feedKey);
    if (
      typeof coverage !== "string" ||
      !/^\d{8}$/.test(coverage) ||
      coverage < serviceDate
    ) {
      throw new Error(
        `The feed has no service dates through ${serviceDate} (latest: ${
          coverage ?? "unknown"
        }).`,
      );
    }
  };

  const result = await replaceFeed(
    db,
    feedKey,
    digest,
    expectedDigest,
    async () => {
      const zip = await openPromise(archive, { autoClose: false });
      try {
        const entries = new Map<string, Entry>();
        for await (const entry of zip.eachEntry()) {
          const name = entry.fileName;
          if (
            !importOrder.some((resource) => resources[resource].file === name)
          ) {
            continue;
          }
          if (entries.has(name) || entry.uncompressedSize > 2 * 1024 ** 3) {
            throw new Error(`Duplicate or oversized GTFS file: ${name}`);
          }
          entries.set(name, entry);
        }

        for (const resource of required) {
          if (!entries.has(resources[resource].file)) {
            throw new Error(
              `GTFS is missing ${resources[resource].file} at the ZIP root.`,
            );
          }
        }
        if (
          !entries.has("calendar.txt") &&
          !entries.has("calendar_dates.txt")
        ) {
          throw new Error("GTFS needs calendar.txt or calendar_dates.txt.");
        }

        const counts: Partial<Record<Resource, number>> = {};
        const agencyIds: string[] = [];
        for (const resource of importOrder) {
          const spec = resources[resource];
          const entry = entries.get(spec.file);
          if (!entry) {
            continue;
          }

          const columns = [...new Set<string>([...spec.key, ...spec.filters])];
          const names = ["feed_key", ...columns, "record"];
          const insert = db.prepare(
            `INSERT INTO ${tableName(resource)} (${names.join(", ")})
                     VALUES (${names.map(() => "?").join(", ")})`,
          );
          let count = 0;
          const stream = await zip.openReadStreamPromise(entry);
          await pipeline(
            stream,
            parse({
              bom: true,
              columns: (header: string[]) => {
                const names = header.map((name) => name.trim());
                if (new Set(names).size !== names.length) {
                  throw new Error(`Duplicate columns in ${spec.file}.`);
                }
                return names;
              },
              skip_empty_lines: true,
              max_record_size: 1024 ** 2,
            }),
            async (records: AsyncIterable<CsvRow>) => {
              for await (const row of records) {
                const record: Record<string, string | number> =
                  Object.create(null);
                for (const [key, value] of Object.entries(row)) {
                  if (numericFields.has(key) && value !== "") {
                    const number = Number(value);
                    if (!Number.isFinite(number)) {
                      throw new Error(`Invalid number in ${spec.file}: ${key}`);
                    }
                    record[key] = number;
                  } else {
                    record[key] = value;
                  }
                }

                if (resource === "agencies") {
                  if (
                    !row.agency_name ||
                    !row.agency_url ||
                    !row.agency_timezone
                  ) {
                    throw new Error(
                      "GTFS agency is missing a name, URL, or timezone.",
                    );
                  }
                  agencyIds.push(row.agency_id || "");
                  record.agency_id = row.agency_id || "";
                }
                if (resource === "routes") {
                  if (
                    !(row.route_short_name || row.route_long_name) ||
                    typeof record.route_type !== "number"
                  ) {
                    throw new Error(
                      "GTFS route is missing a name or route type.",
                    );
                  }
                  record.agency_id =
                    row.agency_id ||
                    (agencyIds.length === 1 ? agencyIds[0] : "");
                }
                const values = columns.map((column) => {
                  const value = record[column];
                  if (value !== undefined && value !== "") {
                    return value;
                  }
                  if (column === "agency_id" && agencyIds.length === 1) {
                    return "";
                  }
                  if (optionalColumns.has(column) && column !== spec.key[0]) {
                    return null;
                  }
                  throw new Error(
                    `Missing ${column} in ${
                      spec.file
                    } at data row ${count + 1}.`,
                  );
                });
                try {
                  insert.run(feedKey, ...values, JSON.stringify(record));
                } catch (error) {
                  throw new Error(
                    `Could not import ${
                      spec.file
                    } data row ${count + 1}: ${String(error)}`,
                    { cause: error },
                  );
                }
                count++;
              }
            },
          );
          if (required.includes(resource) && count === 0) {
            throw new Error(`GTFS file ${spec.file} contains no records.`);
          }
          if (
            resource === "agencies" &&
            agencyIds.length > 1 &&
            agencyIds.includes("")
          ) {
            throw new Error(
              "Every agency in a multi-agency feed needs an agency_id.",
            );
          }
          counts[resource] = count;
        }

        if (!counts.calendars && !counts["calendar-dates"]) {
          throw new Error("The feed contains no service dates.");
        }
        const missingService = db
          .prepare(
            `
                SELECT service_id FROM trips WHERE feed_key = ?
                EXCEPT SELECT service_id FROM calendars WHERE feed_key = ?
                EXCEPT SELECT service_id FROM calendar_dates WHERE feed_key = ?
                LIMIT 1
            `,
          )
          .get(feedKey, feedKey, feedKey);
        if (missingService) {
          throw new Error(
            `Trip references missing service_id: ${missingService.service_id}`,
          );
        }
        ensureCoverage();
        return counts;
      } finally {
        zip.close();
      }
    },
  );
  if (!result.changed) ensureCoverage();
  return result;
}
