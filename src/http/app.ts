import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { createDocs } from "./docs";
import { createV2 } from "./v2";

export function createApp(db: DatabaseSync) {
  const app = new Hono();
  app.route("/", createDocs());
  app.route("/api/v2", createV2(db));
  app.get("/health", (c) => c.json({ status: "ok" }));
  return app;
}
