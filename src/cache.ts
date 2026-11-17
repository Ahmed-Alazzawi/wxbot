/**
 * A small read-through cache stored in D1.
 *
 * "Read-through" means callers ask the cache for a value and hand it a
 * function that can fetch the real thing. If a fresh copy is stored we return
 * it; otherwise we call the function, store the result, and return it.
 *
 * Why cache: weather reports only change about once an hour, so ten people
 * running /metar KSAN in a minute should cost one request to the weather
 * service, not ten. It is also faster for everyone after the first.
 */

import { errorFields, logEvent } from "./log";

const nowSeconds = () => Math.floor(Date.now() / 1000);

export async function cachedText(
  db: D1Database,
  key: string,
  ttlSeconds: number,
  load: () => Promise<string | null>,
): Promise<string | null> {
  // The cache is an optimisation. If the database has a problem we log it
  // and carry on with a live request rather than failing the command.
  try {
    const row = await db
      .prepare("SELECT body FROM api_cache WHERE key = ? AND expires_at > ?")
      .bind(key, nowSeconds())
      .first<{ body: string | null }>();
    if (row) return row.body;
  } catch (err) {
    logEvent("error", "cache_read_failed", { key, ...errorFields(err) });
  }

  const value = await load();

  try {
    await db
      .prepare(
        `INSERT INTO api_cache (key, body, expires_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET body = excluded.body, expires_at = excluded.expires_at`,
      )
      .bind(key, value, nowSeconds() + ttlSeconds)
      .run();
  } catch (err) {
    logEvent("error", "cache_write_failed", { key, ...errorFields(err) });
  }
  return value;
}

/** Deletes stale rows. Called from the scheduled job so the table stays small. */
export async function purgeExpiredCache(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM api_cache WHERE expires_at <= ?").bind(nowSeconds()).run();
}
