import type { DatabaseSync } from "node:sqlite";
import { listImports } from "../storage/sqlite";
import { lisbonToday } from "./service-date";
import { sources } from "./sources";

export function sourceCoverage(db: DatabaseSync, now = new Date()) {
  const today = lisbonToday(now);
  const compact = (date: Temporal.PlainDate) =>
    date.toString().replaceAll("-", "");
  const nextWeek = compact(
    Temporal.PlainDate.from(
      `${today.slice(0, 4)}-${today.slice(4, 6)}-${today.slice(6)}`,
    ).add({ days: 7 }),
  );
  const rows = new Map(
    listImports(db, today).map((row) => [row.agency_key, row]),
  );
  const expiredBy = (time: unknown, hours: number) =>
    typeof time === "string" &&
    now.getTime() - Date.parse(time) >= hours * 3_600_000;

  return [...sources].map(([key, source]) => {
    const snapshot = rows.get(key) ?? null;
    const alerts: string[] = [];
    if (!snapshot?.imported_at) alerts.push("missing_snapshot");
    if (snapshot?.refresh_status === "failed") alerts.push("refresh_failed");
    if (
      snapshot?.refresh_status === "running" &&
      expiredBy(snapshot.refresh_started_at, 2)
    ) {
      alerts.push("refresh_stalled");
    }
    if (snapshot?.imported_at) {
      if (snapshot.schedule_status === "expired")
        alerts.push("schedule_expired");
      else if (snapshot.schedule_status === "upcoming")
        alerts.push("schedule_upcoming");
      else if (snapshot.schedule_status === "unknown")
        alerts.push("schedule_unknown");
      else if (String(snapshot.service_end_date) <= nextWeek)
        alerts.push("schedule_expiring");

      const lastSuccess =
        snapshot.refresh_status === "imported" ||
        snapshot.refresh_status === "unchanged"
          ? snapshot.refresh_finished_at
          : snapshot.imported_at;
      if (
        expiredBy(lastSuccess, 48) &&
        snapshot.refresh_status !== "failed" &&
        snapshot.refresh_status !== "running"
      ) {
        alerts.push("refresh_overdue");
      }
    }
    return {
      key,
      name: source.name,
      alerts,
    };
  });
}
