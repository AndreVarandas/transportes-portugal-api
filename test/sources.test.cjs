const assert = require("node:assert/strict");
const test = require("node:test");
const { resolveSource } = require("../dist/transit/sources");

test("resolves the latest same-site CKAN ZIP and ignores other resource types", async () => {
  const source = {
    url: "https://catalog.example/api/metadata",
    format: "ckan",
  };
  const resources = [
    { format: "gtfs", url: "/old.zip", created: "2025-11-01" },
    { format: "zip", url: "/new.zip", last_modified: "2026-11-01" },
    { format: "html", url: "/about", created: "2027-01-01" },
    {
      format: "zip",
      url: "https://other.example/feed.zip",
      created: "2027-01-01",
    },
  ];
  const request = async () =>
    Response.json({ success: true, result: { resources } });
  assert.equal(
    await resolveSource(source, request),
    "https://catalog.example/new.zip",
  );
});

test("follows the operator page’s GTFS link and rejects ambiguous archives", async () => {
  const source = { url: "https://operator.example/data", format: "zip-link" };
  const link = '<a href="/files/794/google_transit.zip">Download</a>';
  const request = async () =>
    new Response(link + '<a href="/terms.zip">Terms</a>');
  assert.equal(
    await resolveSource(source, request),
    "https://operator.example/files/794/google_transit.zip",
  );
  await assert.rejects(
    resolveSource(
      source,
      async () => new Response(link + '<a href="/gtfs.zip">Other</a>'),
    ),
    /Could not identify/,
  );
});
