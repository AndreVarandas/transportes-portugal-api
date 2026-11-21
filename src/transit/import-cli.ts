import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import {
  currentDigest,
  finishRefresh,
  openDatabase,
  startRefresh,
} from "../storage/sqlite";
import { importFeed } from "./import-feed";
import { lisbonToday } from "./service-date";
import { resolveSource, sources } from "./sources";

async function refresh(feedKey: string, localArchive?: string) {
  const source = sources.get(feedKey);
  if (!localArchive && !source) {
    throw new Error(
      `No download source configured for "${feedKey}". Provide a local ZIP.`,
    );
  }

  const db = openDatabase();
  let temp: string | undefined;
  let attemptId: string | undefined;
  try {
    attemptId = startRefresh(db, feedKey);
    const expectedDigest = currentDigest(db, feedKey);
    let archive = localArchive;
    if (!archive && source) {
      const downloadUrl = await resolveSource(source);
      console.log(`Downloading ${feedKey} GTFS from ${downloadUrl}`);
      temp = await mkdtemp(join(tmpdir(), "transit-gtfs-"));
      archive = join(temp, "feed.zip");
      const response = await fetch(downloadUrl, {
        signal: AbortSignal.timeout(180_000),
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error(`Feed download failed with HTTP ${response.status}.`);
      }
      await pipeline(response.body, createWriteStream(archive));
    }

    if (!archive) {
      throw new Error("No GTFS archive to import.");
    }
    const result = await importFeed(
      db,
      feedKey,
      archive,
      expectedDigest,
      localArchive ? undefined : lisbonToday(),
    );
    finishRefresh(
      db,
      feedKey,
      attemptId,
      result.changed ? "imported" : "unchanged",
    );
    if (result.changed) {
      console.log(`Imported ${feedKey}: ${JSON.stringify(result.counts)}`);
    } else {
      console.log(`${feedKey} archive is unchanged.`);
    }
  } catch (error) {
    if (attemptId) {
      try {
        finishRefresh(
          db,
          feedKey,
          attemptId,
          "failed",
          localArchive
            ? "Local archive import failed. See the importer log."
            : temp
              ? errorMessage(error).replaceAll(temp, "[download directory]")
              : errorMessage(error),
        );
      } catch (statusError) {
        console.error(
          `Could not record refresh outcome: ${errorMessage(statusError)}`,
        );
      }
    }
    throw error;
  } finally {
    db.close();
    if (temp) {
      await rm(temp, { recursive: true, force: true });
    }
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function main() {
  const [feedKey, localArchive, ...extra] = process.argv.slice(2);
  if ((feedKey === "--list" || feedKey === "--help") && !localArchive) {
    console.log(
      "Usage: npm run import -- <feed-key> [archive.zip] or npm run import -- --all",
    );
    console.log("\nConfigured feeds:");
    for (const [key, source] of sources)
      console.log(`  ${key} — ${source.name}`);
    return;
  }
  if (!feedKey || extra.length || (feedKey === "--all" && localArchive)) {
    throw new Error(
      "Usage: npm run import -- <feed-key> [archive.zip] or npm run import -- --all",
    );
  }
  if (feedKey !== "--all") {
    await refresh(feedKey, localArchive);
    return;
  }

  for (const key of sources.keys()) {
    try {
      await refresh(key);
    } catch (error) {
      console.error(`${key}: ${errorMessage(error)}`);
      process.exitCode = 1;
    }
  }
}

main().catch((error) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
