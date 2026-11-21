import { join } from "node:path";
import { importFeed } from "../transit/import-feed";
import { serve } from "@hono/node-server";
import { openDatabase } from "../storage/sqlite";
import { createApp } from "./app";

async function main() {
  const demo = process.argv.includes("--demo");
  const db = demo ? openDatabase(":memory:") : openDatabase();
  if (demo) {
    await importFeed(
      db,
      "demo",
      join(__dirname, "../../test/fixtures/sample-gtfs.zip"),
      undefined,
    );
    console.log(
      "Demo mode: synthetic schedules for 2026-11-20, stored in memory.",
    );
  }
  const app = createApp(db);
  const hostname = process.env.HOST || "127.0.0.1";
  const port = Number(process.env.PORT || 3000);

  serve({ fetch: app.fetch, hostname, port }, (info) => {
    console.log(
      `Interactive API reference: http://${hostname}:${info.port}/docs`,
    );
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
