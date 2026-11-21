type Source = { url: string; format?: "ckan" | "zip-link" };

export const sources = new Map<
  string,
  Source & { name: string; region: string; mode: string }
>([
  [
    "carris",
    {
      name: "Carris",
      region: "Lisbon",
      mode: "Bus and tram",
      url: "https://gateway.carris.pt/gateway/gtfs/api/v2.11/GTFS",
    },
  ],
  [
    "cp",
    {
      name: "Comboios de Portugal",
      region: "Mainland Portugal (CP network)",
      mode: "Rail",
      url: "https://publico.cp.pt/gtfs/gtfs.zip",
    },
  ],
  [
    "fertagus",
    {
      name: "Fertagus",
      region: "Lisbon and Setúbal",
      mode: "Rail",
      url: "https://www.fertagus.pt/GTFSTMLzip/Fertagus_GTFS.zip",
    },
  ],
  [
    "metro-lisboa",
    {
      name: "Metropolitano de Lisboa",
      region: "Greater Lisbon",
      mode: "Metro",
      url: "https://dados.gov.pt/api/1/datasets/r/d10117eb-fb63-4b7a-8008-929232d67db7",
    },
  ],
  [
    "mts",
    {
      name: "Metro Transportes do Sul",
      region: "Almada and Seixal",
      mode: "Light rail",
      url: "https://mts.pt/imt/MTS-20240129.zip",
    },
  ],
  [
    "tcb",
    {
      name: "Transportes Colectivos do Barreiro",
      region: "Barreiro",
      mode: "Bus",
      url: "https://backend.tcbarreiro.pt/download-gtfs",
    },
  ],
  [
    "carris-metropolitana",
    {
      name: "Carris Metropolitana",
      region: "Lisbon metropolitan area",
      mode: "Bus",
      url: "https://api.carrismetropolitana.pt/gtfs",
    },
  ],
  [
    "stcp",
    {
      name: "STCP",
      region: "Porto metropolitan area",
      mode: "Bus",
      url: "https://dadosabertos.cm-porto.pt/api/3/action/package_show?id=horarios-paragens-e-rotas-stcp",
      format: "ckan",
    },
  ],
  [
    "metro-porto",
    {
      name: "Metro do Porto",
      region: "Porto metropolitan area",
      mode: "Light rail",
      url: "https://www.metrodoporto.pt/pages/337",
      format: "zip-link",
    },
  ],
]);

type Resource = {
  url?: string;
  name?: string;
  format?: string;
  created?: string | null;
  last_modified?: string | null;
};

function sameSiteUrl(href: string, page: string, source: string) {
  if (!URL.canParse(href, page)) {
    return undefined;
  }
  const url = new URL(href, page);
  const stripWww = (host: string) => host.replace(/^www\./, "");
  return url.protocol === "https:" &&
    stripWww(url.host) === stripWww(new URL(source).host) &&
    !url.username &&
    !url.password
    ? url.href
    : undefined;
}

export async function resolveSource(source: Source, request = fetch) {
  if (!source.format) {
    return source.url;
  }

  const response = await request(source.url, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Source lookup returned HTTP ${response.status}.`);
  }

  const page = response.url || source.url;
  if (source.format === "ckan") {
    const catalog = (await response.json()) as {
      success?: boolean;
      result?: { resources?: Resource[] };
    };
    const date = (resource: Resource) =>
      [resource.last_modified || "", resource.created || ""].sort()[1];
    if (catalog.success && Array.isArray(catalog.result?.resources)) {
      const newest = catalog.result.resources
        .filter(
          (resource) =>
            resource.url && /^(zip|gtfs)$/i.test(resource.format || ""),
        )
        .sort((a, b) => date(b).localeCompare(date(a)))
        .find((resource) => sameSiteUrl(resource.url!, page, source.url));
      if (newest) {
        return sameSiteUrl(newest.url!, page, source.url)!;
      }
    }
  } else {
    const html = await response.text();
    const urls = new Set<string>();
    for (const [, href] of html.matchAll(
      /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi,
    )) {
      if (!/(gtfs|google[_-]?transit)[^/?#]*\.zip(?:[?#]|$)/i.test(href)) {
        continue;
      }
      const url = sameSiteUrl(href, page, source.url);
      if (url) {
        urls.add(url);
      }
    }
    if (urls.size === 1) {
      return [...urls][0];
    }
  }
  throw new Error(`Could not identify a GTFS download at ${source.url}.`);
}
