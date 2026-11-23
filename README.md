# Transportes Portugal API

A read API for Portuguese public transport schedules, built with TypeScript, Hono, and SQLite. The registry covers metropolitan operators in Lisbon, Setúbal, and Porto, plus Comboios de Portugal. Coverage varies by provider and by the feeds imported into your database.

## Try the API with sample data

Use Node.js 26.13.1 or newer. If you use nvm, run `nvm install` and `nvm use` from the repository directory to select the version in `.nvmrc`.

```sh
npm ci
npm run demo
```

Try nearby stop search and query the first stop’s sample **01:01** departure using the [interactive API reference](http://127.0.0.1:3000/docs) or curl:

```sh
curl -fsS 'http://127.0.0.1:3000/api/v2/nearby-stops?lat=38.71&lon=-9.15'
curl -fsS 'http://127.0.0.1:3000/api/v2/feeds/demo/stops/s1/departures?from=2026-11-21T00:50:00Z'
```

The demo loads a bundled synthetic feed into memory, so starting it requires no provider download and leaves your SQLite file untouched. Its sample schedules use the fixed service date above.

## Run with operator data

```sh
npm run import -- --list
npm run import -- carris
npm start
```

The API listens on `127.0.0.1:3000`. Use `npm run dev` for watch mode and `npm test` for integration tests. Set `HOST` or `PORT` to change the listener. The database is generated under `data/transit.sqlite` and ignored by Git. Set `SQLITE_PATH` for both the server and importer if you use a different file.

### Run with Docker Compose

Install Docker with the Compose plugin. The image builds the API using the Node.js version in `.nvmrc`, so a host Node.js installation is optional.

```sh
docker compose up -d --build --wait
docker compose run --rm api node dist/transit/import-cli.js carris
curl -fsS 'http://127.0.0.1:3000/api/v2/feeds/carris'
```

The API starts with an empty SQLite database. Import feeds in a separate command while the server is running. The container runs the compiled importer directly, which skips the npm build hook needed for local development. Both commands use the same named volume, `transit-data`, for SQLite and its WAL files. Container replacement and `docker compose down` preserve the volume. `docker compose down --volumes` deletes it.

The host port defaults to 3000 and binds to loopback. To change it, set `API_PORT`, for example `API_PORT=3001 docker compose up -d`. For public hosting, put an HTTPS reverse proxy in front of the API. The Compose health check probes `/health`. Monitor `/api/v2/source-health` separately for feed freshness.

To import a local archive, mount it read-only in the importer container. This example loads the small synthetic test fixture without downloading an operator feed:

```sh
docker compose run --rm \
  -v "$PWD/test/fixtures/sample-gtfs.zip:/tmp/sample-gtfs.zip:ro" \
  api node dist/transit/import-cli.js demo /tmp/sample-gtfs.zip
curl -fsS 'http://127.0.0.1:3000/api/v2/feeds/demo'
```

Use a separate Compose project such as `docker compose -p transit-demo` for test data if the default project serves real feeds. For a full operator refresh on a Compose deployment, schedule the following command on the host where the Compose project runs:

```sh
docker compose run --rm -T api node dist/transit/import-cli.js --all
```

### Disk space

| Setup | Measured SQLite database size | Recommended free space before setup |
| --- | ---: | ---: |
| Carris only (`npm run import -- carris`) | About 0.9 GiB | 4 GiB |
| All nine feeds (`npm run import -- --all`) | About 7 GiB | 20 GiB |

The recommendations allow for dependencies, temporary GTFS downloads, and SQLite's write-ahead log during refreshes. The full staging refresh peaked at **12.64 GiB** for the SQLite database and its sidecar files alone. These are sizing estimates from the November 2026 feeds. Storage needs grow as operators publish larger feeds or you add providers. If your temp directory and `SQLITE_PATH` are on different volumes, allow room for ZIP downloads on the temp volume. With Docker, check the container engine’s storage as well as free space on the host.

## Refresh schedules

```sh
npm run import -- cp      # refresh one feed
npm run import -- --all   # refresh all configured feeds in sequence
```

The importer downloads from the configured source each time. For STCP it queries Porto’s CKAN catalog for the latest archive, and for Metro do Porto it follows the current ZIP link on the operator’s open-data page. The other providers have direct download URLs. The importer skips identical archives and rejects remote snapshots whose declared service dates have expired. A failed refresh preserves the previous snapshot. The batch continues after individual failures and exits with a nonzero status if any refresh fails.

The command can run manually or from an external scheduler. Starting the API leaves refresh timing to the operator. `GET /api/v2/feeds` shows the last publication, declared service dates, and the latest refresh attempt for imported or attempted feeds. Carris Metropolitana is substantially larger than the other feeds, so allow extra disk space and time for its import.

Feed service dates use GTFS `YYYYMMDD` format. `schedule_status` compares the declared range with today's date in Lisbon and reports `in_range`, `upcoming`, `expired`, or `unknown`. An in-range feed may still have dates with no scheduled service. `refresh_status` reports `running`, `imported`, `unchanged`, or `failed`, with start and finish timestamps and an error for failed attempts. An interrupted attempt can show as running until the next refresh. Existing snapshots get their date range from the stored calendars and show a refresh status after their next attempt.

In a local staging run on 20 November 2026, refreshing all nine feeds and forcing a replacement of the existing Carris Metropolitana snapshot took about seven minutes. A repeated local Carris Metropolitana route lookup had a 2.15 ms p95 across 1,635 requests with no errors.

On the deployment host, schedule `npm run import -- --all` daily using the same `SQLITE_PATH` and Node installation as the API. Capture stdout and stderr and monitor the process exit status. The `/api/v2/sources` endpoint lists configured operators by region and mode, with metadata for each local snapshot.

For a deployment expected to import all configured feeds, monitor `GET /api/v2/source-health` independently from `GET /health`. For example, run this daily after the refresh:

```sh
curl --silent --show-error --fail-with-body http://127.0.0.1:3000/api/v2/source-health
```

The feed check returns HTTP 503 with per-provider alert codes when a snapshot is missing, the latest refresh failed or has run for at least two hours, a successful refresh is overdue by 48 hours, or schedule coverage is unknown, upcoming, expired, or ending within seven days. It evaluates all default providers, so partial installations and demo mode can report attention even when the server is running normally.

For an offline import, pass a local ZIP with the GTFS files at its root:

```sh
npm run import -- carris /path/to/feed.zip
```

### Provider sources

| Feed key | Provider and source |
| --- | --- |
| `carris` | [Carris GTFS](https://gateway.carris.pt/gateway/gtfs/api/v2.11/GTFS) |
| `cp` | [Comboios de Portugal GTFS](https://publico.cp.pt/gtfs/gtfs.zip) |
| `fertagus` | [Fertagus GTFS](https://www.fertagus.pt/GTFSTMLzip/Fertagus_GTFS.zip) |
| `metro-lisboa` | [Metropolitano de Lisboa on dados.gov.pt](https://dados.gov.pt/pt/datasets/gtfs-do-metropolitano-de-lisboa/) |
| `mts` | [Metro Transportes do Sul GTFS](https://mts.pt/imt/MTS-20240129.zip) |
| `tcb` | [Transportes Colectivos do Barreiro open data](https://tcbarreiro.pt/tcb-transportes-colectivos-do-barreiro/dados-abertos/) |
| `carris-metropolitana` | [Carris Metropolitana official GTFS](https://github.com/carrismetropolitana/gtfs) |
| `stcp` | [STCP dataset, Porto open data](https://dadosabertos.cm-porto.pt/dataset/horarios-paragens-e-rotas-stcp) |
| `metro-porto` | [Metro do Porto operator download page](https://www.metrodoporto.pt/pages/337) |

The legacy Transporlis URLs timed out, and the two original Porto ZIP URLs returned 404 on 20 November 2026. The legacy provider names map to current coverage as follows:

- Rodoviária de Lisboa, TST, and Sulfertagus’s former public bus services in the Lisbon metropolitan area are covered by Carris Metropolitana. [Operator transition FAQ](https://www.alsatodi.pt/documents/38062132/38068508/faq-carris-metropolitana.pdf/1eeb6f80-9411-b634-0e21-35c41f9d0e4a?t=1653575031145)
- Transtejo and Soflusa share one TTSL feed. The [operator ZIP](https://api.transtejo.pt/files/GTFS.zip) timed out locally. The [Mobility Database archive](https://mobilitydatabase.org/feeds/gtfs/mdb-2921) has a downloadable snapshot from 17 August 2026 for manual use. Verify that snapshot against current operator schedules before relying on it.
- Carristur / Yellow Bus has no current public GTFS source verified in this audit.

### Coverage gaps

The default registry has no island operators. Ferry coverage remains open.

For expansion, use Portugal’s [National Access Point for multimodal transport](https://www.nap-portugal.imt-ip.pt/nap/multimodal) alongside operator and municipal catalogs. Track each candidate’s publisher, download URL, licence, service dates, and refresh behaviour before adding it to the default registry.

Two public archives were downloaded and successfully imported into disposable databases on 20 November 2026. The catalog records do not specify a licence, so confirm reuse terms with the publishers before making either feed available through a public API.

| Candidate | Observed service end | Manual import after downloading its ZIP |
| --- | --- | --- |
| [Transportes Urbanos de Braga](https://dados.gov.pt/en/datasets/gtfs-transportes-urbanos-de-braga/) | 28 February 2027 | `npm run import -- braga /path/to/tub.zip` |
| [SMTUC Coimbra](https://dados.gov.pt/en/datasets/gtfs-estaticos-servicos-municipalizados-de-transportes-urbanos-de-coimbra) | 30 December 2026 | `npm run import -- coimbra /path/to/smtuc.zip` |

Additional sources belong in `src/transit/sources.ts`. The importer supports conventional GTFS scheduled trips with stop IDs, including calendar exceptions and after-midnight times.

## Query the API

After starting the server, open [Interactive API reference](http://127.0.0.1:3000/docs). Choose **List feeds**, click **Try it out**, and then **Execute**. Copy a feed key into **List routes**, then use a route ID in **List trips for a route**. Swagger UI shows the live response and a curl command for every request.

Download the [OpenAPI 3.1 document](http://127.0.0.1:3000/openapi.json) to import the v2 API into an API client. The reference and its assets are served locally.

You can also query the read-only v2 API with curl:

```sh
curl -fsS 'http://127.0.0.1:3000/api/v2/feeds/carris/routes?limit=3'
curl -fsS 'http://127.0.0.1:3000/api/v2/feeds/carris/routes/100_0/trips?limit=3'
```

Feed keys scope resource IDs. A route or stop ID may also appear in another feed. All paths below are relative to `/api/v2`.

| GET path | Optional filters |
| --- | --- |
| `/sources` | |
| `/source-health` | |
| `/nearby-stops` | Requires `lat` and `lon`. Optional `radius` in kilometres (default 1, maximum 25). |
| `/stops` | Requires `q` (2 to 100 characters), matched against stop name and code across all feeds. |
| `/feeds`, `/feeds/{feedKey}` | |
| `/feeds/{feedKey}/agencies` | |
| `/feeds/{feedKey}/routes` | `agencyId` |
| `/feeds/{feedKey}/stops` | `routeId`, `tripId` |
| `/feeds/{feedKey}/trips` | `routeId`, `serviceId`, `directionId`, `serviceDate` |
| `/feeds/{feedKey}/routes/{routeId}/patterns` | |
| `/feeds/{feedKey}/routes/{routeId}/pattern-schedule` | Required `patternId` from `/patterns`. Optional `from` timestamp. |
| `/feeds/{feedKey}/routes/{routeId}/trips` | `serviceId`, `directionId`, `serviceDate` |
| `/feeds/{feedKey}/trips/{tripId}/stop-times` | `stopId` |
| `/feeds/{feedKey}/stops/{stopId}/departures` | `from`, `minutes`, `limit`, `routeId` |
| `/feeds/{feedKey}/stops/{stopId}/routes` | |
| `/feeds/{feedKey}/stops/{stopId}/stop-times` | `tripId`, `serviceDate` |
| `/feeds/{feedKey}/trips/{tripId}/frequencies` | |
| `/feeds/{feedKey}/calendars` | `serviceId` |
| `/feeds/{feedKey}/calendar-dates` | `serviceId`, `date` in `YYYY-MM-DD` |
| `/feeds/{feedKey}/shapes` | `routeId`, `tripId` |

`/sources` lists configured providers even on an empty database. Each item includes the region, transport mode, registry URL, and local feed metadata. `feed: null` means no import or refresh attempt has been recorded. A feed with `importedAt: null` has no queryable snapshot. `/feeds` also includes manually loaded feeds.

Nearby stop search returns platforms, stops, and boarding areas from imported feeds, ordered by distance. Each result includes `feedKey`, `id`, and `distanceMeters`. Use both IDs to open the departure board.

For network exploration, `/stops?q=` finds stops by name or code across feeds (prefix matches first), `/feeds/{feedKey}/stops/{stopId}/routes` lists every route that calls at a stop regardless of the current time window, and `/feeds/{feedKey}/routes/{routeId}/patterns` returns each direction/variant with its ordered stops (names, coordinates and a representative trip's times) and drawn path. Pattern IDs match the fleet endpoint's grouping, so live vehicles join the same way. These endpoints describe the scheduled network; they do not plan journeys.

The pattern schedule returns `first` and `last` published departures on the local civil date of `from` and `next` at or after that instant, including a later published service date. It uses departures at the variant's origin, includes GTFS service running after midnight, and preserves headway windows. Each field is null when no matching service is published.

Departures default to the next 120 minutes from now. Use `from` with an ISO timestamp and UTC offset, and `minutes` from 1 to 1440. The response includes `from`, `until`, and the feed's freshness. The board returns up to `limit` events without offset pagination. A `scheduled` row has a local timestamp with its UTC offset. A `headway` row has a service window and a headway in seconds. The board excludes stops that prohibit pickup on the specific trip. `pickupType` flags conditional boarding and `approximate` identifies publisher-marked approximate stop times. The data comes from scheduled GTFS feeds. Real-time delays and cancellations are outside this endpoint.

Pass `serviceDate=YYYY-MM-DD` to select services active on that GTFS service day. Calendar exceptions override the weekly schedule. A time such as `25:10:00` falls on the next civil day but still belongs to the specified service day. Stop-time tables include trip templates for frequency-based service. Use the trip’s frequencies endpoint for its headway windows.

Routes, stops, trips, and shapes also have a detail endpoint. Append the resource ID to the collection path, for example `/feeds/carris/routes/100_0`. Percent-encode IDs used in URLs.

Collections return `{ "data": [...], "pagination": { "limit": 50, "offset": 0, "nextOffset": null } }`. Use `limit` (1 to 200) and `offset` to page through results. A null `nextOffset` means the last page. Details return `{ "data": {...} }`. Responses use documented camelCase fields such as `id`, `shortName`, `routeId`, and `arrivalTime`. Missing optional values are null. Service dates are ISO dates and GTFS schedule times stay relative to the service day, so a time like `25:10:00` is valid.

Errors use `{ "error": { "code": "not_found", "message": "Feed not found." } }`. Invalid collection parameters return 400, unknown resources return 404, and write methods return 405.

## Code quality

Run `npm run format` to format code with Prettier defaults and `npm run lint` to check ESLint's recommended rules, formatting, and TypeScript types. `npm ci` installs the Husky hooks. Before commit, the hook fixes lint and formatting issues in staged code and adds those fixes to the commit. Before push, the hook checks the whole project. GitHub Actions runs the same checks and the tests.

## Releases

GitHub Actions runs lint and tests on pushes and pull requests. After checks pass on the default branch, Release Please uses [Conventional Commits](https://www.conventionalcommits.org/) to open or update a release pull request. Merging that pull request creates a version tag and GitHub release. The release history starts from the existing `v1.0.2` tag.

Release Please uses the built-in `GITHUB_TOKEN`. In the repository's **Settings → Actions → General**, enable **Allow GitHub Actions to create and approve pull requests** so it can open the release PR. GitHub may require a maintainer to approve the checks on the bot's PR before they run.

## License

This project is licensed under the [MIT License](LICENSE).

### Live fleet and route maps

`GET /api/v2/feeds/{feedKey}/routes/{routeId}/fleet` returns the route variants (patterns) of an imported route, plus live vehicle observations where the operator publishes them. `GET /api/v2/feeds/carris-metropolitana/lines/{lineId}/vehicles` remains the line-number shortcut for Carris Metropolitana's four-digit public lines; it uses the official v2 `/vehicles`, `/lines`, `/patterns/{id}`, and `/shapes/{id}` endpoints and does not require an imported GTFS.

The response's `data` contains `feedKey`, `routeId`, `provider`, `liveSupported`, `synthetic`, `attribution`, `lineId`, `name`, `fetchedAt`, `freshForMs` (90 seconds), `vehicles`, `patterns`, `geometryUnavailable`, and `vehiclesUnavailable`. All timestamps are Unix milliseconds; coordinates in pattern arrays are **latitude, longitude**. Vehicle observations older than ten minutes or over 30 seconds in the future are excluded. Clients must continually age positions and count only recent reports, not claim a total number of operating vehicles. Pattern IDs are normalized by removing operator/version prefixes; validity dates use Europe/Lisbon.

Live sources are Carris Metropolitana (official v2 API), Carris (official GTFS-RT vehicle positions), STCP (Porto Digital FIWare broker), and Metro Lisboa, CP, Fertagus, MTS, and TCB through the official TML GO aggregated realtime hub (`go.tmlmobilidade.pt`, open-data organization snapshot). STCP live trip IDs carry schedule variants that differ from the imported GTFS, so an unmatched trip falls back to the reported route and direction. CP positions come only from that official TML feed — which also carries national services — never from unofficial CP endpoints. Hub IDs carry `[plan][agency]` prefixes that are stripped before joining. Observations are joined to imported GTFS trips; where the hub uses operator-native route IDs (Fertagus, MTS, TCB) an unmatched trip falls back to a route join, and Metro Lisboa joins by line letter because its hub trip IDs are not GTFS trip IDs. Reports that cannot be matched to the requested route are omitted. Vehicles without a matched trip have an empty `patternId` and keep the direction reported by the live source. For every other feed, `liveSupported` is `false` and `vehicles` is empty: that means there is no public live source, not that no vehicles are operating. Patterns come from the imported shapes (up to 30 variants, 20 000 points each); missing or oversized geometry sets `geometryUnavailable` without suppressing positions. The synthetic demo feed is marked `synthetic: true`. `/sources` reports `capabilities.liveVehicles` per operator.

Fleet observations share a 10-second in-process cache; route geometry is cached per feed import, and the Carris Metropolitana catalogue and geometry share a bounded five-minute cache. Concurrent upstream requests are deduplicated. A failed or malformed vehicle feed returns route metadata with `vehiclesUnavailable: true`; clients must not interpret this as zero operating vehicles. Unknown routes return 404, invalid CM line IDs 400, and a failed CM catalogue 502. Live data is operator data even when the server is running with the separate synthetic demo feed.
