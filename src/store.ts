/**
 * All database access lives here, so the rest of the code never writes SQL.
 * The database is Cloudflare D1 (SQLite). Tables are defined in
 * migrations/0001_init.sql.
 *
 * Every query uses "?" placeholders with .bind(), never string-building,
 * so user input can't be used for SQL injection.
 */

import type { FlightCategory } from "./conditions";

/** The categories someone can ask to be alerted about. */
export type Threshold = Exclude<FlightCategory, "VFR">;

export interface Subscription {
  id: number;
  userId: string;
  channelId: string;
  station: string;
  threshold: Threshold;
}

export interface StationState {
  station: string;
  category: FlightCategory;
  raw: string;
}

const SUBSCRIPTION_COLUMNS = "id, user_id AS userId, channel_id AS channelId, station, threshold";

/** Adds a subscription, or updates the threshold if it already exists. */
export async function saveSubscription(
  db: D1Database,
  sub: Omit<Subscription, "id">,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO subscriptions (user_id, channel_id, station, threshold)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, channel_id, station) DO UPDATE SET threshold = excluded.threshold`,
    )
    .bind(sub.userId, sub.channelId, sub.station, sub.threshold)
    .run();
}

/** Removes a subscription. Returns true if there was one to remove. */
export async function deleteSubscription(
  db: D1Database,
  userId: string,
  channelId: string,
  station: string,
): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM subscriptions WHERE user_id = ? AND channel_id = ? AND station = ?")
    .bind(userId, channelId, station)
    .run();
  return result.meta.changes > 0;
}

/** Everything one person is subscribed to, across all channels. */
export async function subscriptionsForUser(db: D1Database, userId: string): Promise<Subscription[]> {
  const result = await db
    .prepare(`SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions WHERE user_id = ? ORDER BY station`)
    .bind(userId)
    .all<Subscription>();
  return result.results;
}

export async function allSubscriptions(db: D1Database): Promise<Subscription[]> {
  const result = await db.prepare(`SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions`).all<Subscription>();
  return result.results;
}

export async function allStationStates(db: D1Database): Promise<Map<string, StationState>> {
  const result = await db.prepare("SELECT station, category, raw FROM station_state").all<StationState>();
  return new Map(result.results.map((row) => [row.station, row]));
}

function upsertStateStatement(db: D1Database, state: StationState): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO station_state (station, category, raw, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT (station) DO UPDATE SET
         category = excluded.category, raw = excluded.raw, updated_at = excluded.updated_at`,
    )
    .bind(state.station, state.category, state.raw);
}

/**
 * Applies everything the scheduled job learned in one round trip:
 * new station states, and channels the bot can no longer post to.
 */
export async function applyAlertRun(
  db: D1Database,
  states: StationState[],
  deadChannelIds: string[],
): Promise<void> {
  const statements = [
    ...states.map((state) => upsertStateStatement(db, state)),
    ...deadChannelIds.map((id) => db.prepare("DELETE FROM subscriptions WHERE channel_id = ?").bind(id)),
    // Forget airports nobody is subscribed to any more.
    db.prepare("DELETE FROM station_state WHERE station NOT IN (SELECT station FROM subscriptions)"),
  ];
  await db.batch(statements);
}

/** Records the current category for a station only if we have none yet. */
export async function rememberStateIfNew(db: D1Database, state: StationState): Promise<void> {
  await db
    .prepare("INSERT INTO station_state (station, category, raw) VALUES (?, ?, ?) ON CONFLICT (station) DO NOTHING")
    .bind(state.station, state.category, state.raw)
    .run();
}
