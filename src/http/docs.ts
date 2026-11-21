import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { dirname, join } from "node:path";
import { openapi } from "./openapi";

const assets = dirname(require.resolve("swagger-ui-dist/package.json"));

export function createDocs() {
  const app = new Hono();
  app.get("/", (c) => c.redirect("/docs"));
  app.get("/openapi.json", (c) => c.json(openapi));
  app.get("/docs", (c) =>
    c.html(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Transportes Portugal API reference</title>
    <link rel="icon" href="data:,">
    <link rel="stylesheet" href="/docs/swagger-ui.css">
    <script src="/docs/swagger-ui-bundle.js" defer></script>
    <script src="/docs/init.js" defer></script>
  </head>
  <body>
    <main id="swagger-ui"></main>
  </body>
</html>`),
  );
  app.get("/docs/init.js", (c) =>
    c.body(
      `SwaggerUIBundle({
        url: "/openapi.json",
        dom_id: "#swagger-ui",
        deepLinking: true,
        docExpansion: "list",
        displayRequestDuration: true,
        supportedSubmitMethods: ["get"],
        validatorUrl: null
      });`,
      200,
      { "Content-Type": "application/javascript; charset=utf-8" },
    ),
  );
  for (const file of ["swagger-ui.css", "swagger-ui-bundle.js"]) {
    app.get(`/docs/${file}`, serveStatic({ path: join(assets, file) }));
  }
  return app;
}
