import type { DatabaseSync } from "node:sqlite";
import { createRouteFleet } from "../transit/route-fleet";
import { Hono } from "hono";
import { createFleetService } from "../transit/live-fleet";

export function createLiveFleet(db: DatabaseSync) {
  const app = new Hono();
  const fleet = createFleetService();
  app.get("/feeds/carris-metropolitana/lines/:lineId/vehicles", async (c) => {
    const lineId = c.req.param("lineId");
    c.header("Cache-Control", "no-store");
    if (!/^\d{4}$/.test(lineId))
      return c.json({ error: { code: "invalid_line" } }, 400);
    try {
      const data = await fleet(lineId);
      return data
        ? c.json({ data })
        : c.json({ error: { code: "line_not_found" } }, 404);
    } catch {
      return c.json({ error: { code: "live_unavailable" } }, 502);
    }
  });
  const routeFleet = createRouteFleet(db);
  app.get("/feeds/:feedKey/routes/:routeId/fleet", async (c) => {
    c.header("Cache-Control", "no-store");
    try {
      const data = await routeFleet(
        c.req.param("feedKey"),
        c.req.param("routeId"),
      );
      return data
        ? c.json({ data })
        : c.json({ error: { code: "route_not_found" } }, 404);
    } catch {
      return c.json({ error: { code: "fleet_unavailable" } }, 502);
    }
  });
  return app;
}
