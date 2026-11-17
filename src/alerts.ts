/**
 * Alert logic: decides who should be told when an airport's flight category
 * changes, and runs the scheduled check.
 */

import type { FlightCategory } from "./conditions";
import { sendChannelMessage, type SendResult } from "./discord";
import { alertEmbed } from "./format";
import { parseMetar, type DecodedMetar } from "./metar";
import { allStationStates, allSubscriptions, applyAlertRun, type StationState, type Subscription, type Threshold } from "./store";
import { fetchRawMetars } from "./weather";

const RANK: Record<FlightCategory, number> = { VFR: 0, MVFR: 1, IFR: 2, LIFR: 3 };

export const isWorse = (a: FlightCategory, b: FlightCategory) => RANK[a] > RANK[b];
const atOrBelow = (category: FlightCategory, threshold: Threshold) => RANK[category] >= RANK[threshold];

/**
 * Should a subscriber hear about this change?
 * Yes when conditions cross their threshold in either direction, or move
 * between two categories that are both at or below it (IFR -> LIFR).
 * No when the change happens entirely above it (VFR -> MVFR for an IFR alert).
 */
export function shouldNotify(previous: FlightCategory, current: FlightCategory, threshold: Threshold): boolean {
  if (previous === current) return false;
  return atOrBelow(previous, threshold) || atOrBelow(current, threshold);
}

export interface AlertRunResult {
  stationsChecked: number;
  alertsSent: number;
  channelsRemoved: number;
}

/** Things the alert run needs from outside. Passed in so tests can swap them. */
export interface AlertDeps {
  db: D1Database;
  botToken: string;
  fetchMetars?: (stations: string[]) => Promise<Map<string, string>>;
  send?: (token: string, channelId: string, payload: unknown) => Promise<SendResult>;
  /** Cloudflare's free plan allows 50 outgoing requests per run; we stay under it. */
  maxSends?: number;
}

function safeParse(raw: string): DecodedMetar | null {
  try {
    return parseMetar(raw);
  } catch {
    return null;
  }
}

/**
 * The scheduled job. For every airport someone is subscribed to:
 * fetch the latest report, compare its flight category with the one we
 * stored last time, and post an alert in each channel that asked for it.
 */
export async function runAlertCheck(deps: AlertDeps): Promise<AlertRunResult> {
  const fetchMetars = deps.fetchMetars ?? fetchRawMetars;
  const send = deps.send ?? sendChannelMessage;
  let sendsLeft = deps.maxSends ?? 40;

  const subscriptions = await allSubscriptions(deps.db);
  const result: AlertRunResult = { stationsChecked: 0, alertsSent: 0, channelsRemoved: 0 };
  if (subscriptions.length === 0) return result;

  const byStation = new Map<string, Subscription[]>();
  for (const sub of subscriptions) {
    byStation.set(sub.station, [...(byStation.get(sub.station) ?? []), sub]);
  }

  const [states, metars] = await Promise.all([allStationStates(deps.db), fetchMetars([...byStation.keys()])]);

  const newStates: StationState[] = [];
  const deadChannels = new Set<string>();

  for (const [station, subs] of byStation) {
    const raw = metars.get(station);
    const metar = raw ? safeParse(raw) : null;
    // No report, or one we can't classify: leave the stored state alone.
    if (!raw || !metar || !metar.flightCategory) continue;
    result.stationsChecked++;

    const current = metar.flightCategory;
    const previous = states.get(station)?.category;
    if (!previous) {
      // First time we've seen this airport: remember it, nothing to compare yet.
      newStates.push({ station, category: current, raw });
      continue;
    }
    if (previous === current) continue;

    // One message per channel, mentioning everyone there who wants this alert.
    const byChannel = new Map<string, string[]>();
    for (const sub of subs) {
      if (deadChannels.has(sub.channelId) || !shouldNotify(previous, current, sub.threshold)) continue;
      byChannel.set(sub.channelId, [...(byChannel.get(sub.channelId) ?? []), sub.userId]);
    }

    // Out of budget for this run: stop here. This airport's stored state is
    // unchanged, so the next run (5 minutes later) picks it up.
    if (byChannel.size > sendsLeft) break;

    let anyFailed = false;
    for (const [channelId, userIds] of byChannel) {
      sendsLeft--;
      const outcome = await send(deps.botToken, channelId, {
        content: userIds.map((id) => `<@${id}>`).join(" "),
        embeds: [alertEmbed(metar, previous)],
        allowed_mentions: { users: userIds },
      });
      if (outcome === "sent") result.alertsSent++;
      else if (outcome === "gone") deadChannels.add(channelId);
      else anyFailed = true;
    }

    // If a send failed for a temporary reason, keep the old state so we retry next run.
    if (!anyFailed) newStates.push({ station, category: current, raw });
  }

  result.channelsRemoved = deadChannels.size;
  await applyAlertRun(deps.db, newStates, [...deadChannels]);
  return result;
}
