import { getPlatformProxy } from "wrangler";
// "?raw" tells the test runner to hand us the file's text.
import init from "../migrations/0001_init.sql?raw";
import cache from "../migrations/0002_cache.sql?raw";

/**
 * Starts a real, throwaway copy of the D1 database on this computer and
 * creates the tables from the migration file. Nothing here touches the
 * live database.
 */
export async function createTestDb(): Promise<{ db: D1Database; dispose: () => Promise<void> }> {
  const proxy = await getPlatformProxy<{ DB: D1Database }>({ persist: false });
  const db = proxy.env.DB;

  const statements = `${init}\n${cache}`
    .replace(/--.*$/gm, "") // strip comments
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  await db.batch(statements.map((s) => db.prepare(s)));

  return { db, dispose: proxy.dispose };
}

export async function clearTestDb(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM subscriptions"),
    db.prepare("DELETE FROM station_state"),
    db.prepare("DELETE FROM api_cache"),
  ]);
}
