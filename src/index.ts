/**
 * Aviation weather Discord bot - Cloudflare Worker entry point.
 *
 * How it works: Discord sends an HTTP POST to this Worker every time someone
 * uses a slash command. We (1) verify the request really came from Discord,
 * (2) work out which command it was, and (3) reply with JSON.
 * There is no always-on server and no persistent connection to Discord.
 */

import { verifyDiscordRequest } from "./verify";
import { fetchAirport, fetchRawMetar, fetchRawTaf, normalizeStationId, WeatherApiError } from "./weather";
import { cachedText, purgeExpiredCache } from "./cache";
import { errorFields, logEvent } from "./log";
import { parseMetar } from "./metar";
import { parseTaf } from "./taf";
import { parseAirport, runwayWinds } from "./crosswind";
import { crosswindEmbed, metarEmbed, tafEmbed } from "./format";
import { runAlertCheck } from "./alerts";
import {
  deleteSubscription,
  rememberStateIfNew,
  saveSubscription,
  subscriptionsForUser,
  type Threshold,
} from "./store";

export interface Env {
  /** Public Key from the Discord Developer Portal (General Information). */
  DISCORD_PUBLIC_KEY: string;
  /** Bot token, needed to post alerts. Set with "wrangler secret put". */
  DISCORD_BOT_TOKEN: string;
  /** The D1 database that stores alert subscriptions. */
  DB: D1Database;
}

/** What a command handler gets to work with. */
interface CommandContext {
  env: Env;
  interaction: any;
  /** The airport code the user typed, cleaned up. Empty for commands without one. */
  station: string;
}

const MAX_SUBSCRIPTIONS_PER_USER = 10;

// How long each kind of data is reused before asking the weather service again.
const METAR_TTL = 2 * 60; // reports come out about hourly, with specials in between
const TAF_TTL = 10 * 60; // forecasts are issued every few hours
const AIRPORT_TTL = 7 * 24 * 60 * 60; // runways don't move

const cachedMetar = (env: Env, station: string) =>
  cachedText(env.DB, `metar:${station}`, METAR_TTL, () => fetchRawMetar(station));
const cachedTaf = (env: Env, station: string) =>
  cachedText(env.DB, `taf:${station}`, TAF_TTL, () => fetchRawTaf(station));
async function cachedAirport(env: Env, station: string): Promise<unknown | null> {
  const text = await cachedText(env.DB, `airport:${station}`, AIRPORT_TTL, async () => {
    const airport = await fetchAirport(station);
    return airport ? JSON.stringify(airport) : null;
  });
  return text ? JSON.parse(text) : null;
}
const THRESHOLD_TEXT: Record<Threshold, string> = {
  MVFR: "MVFR or worse",
  IFR: "IFR or worse",
  LIFR: "LIFR",
};

// Discord interaction types (what Discord sends us).
const PING = 1;
const APPLICATION_COMMAND = 2;

// Discord response types (what we send back).
const PONG = 1;
const CHANNEL_MESSAGE = 4;

// Message flag: only the person who ran the command sees the reply.
const EPHEMERAL = 64;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function message(content: string, ephemeral = false): Response {
  return json({
    type: CHANNEL_MESSAGE,
    data: { content, flags: ephemeral ? EPHEMERAL : 0 },
  });
}

const embed = (e: unknown): Response => json({ type: CHANNEL_MESSAGE, data: { embeds: [e] } });
const codeBlock = (text: string) => `\`\`\`\n${text}\n\`\`\``;

async function handleMetar({ env, station }: CommandContext): Promise<Response> {
  const raw = await cachedMetar(env, station);
  if (!raw) return message(`No recent METAR found for \`${station}\`.`, true);
  try {
    return embed(metarEmbed(parseMetar(raw)));
  } catch (err) {
    // If the decoder can't handle a report, still show the raw text.
    logEvent("error", "metar_decode_failed", { raw, ...errorFields(err) });
    return message(codeBlock(raw));
  }
}

async function handleTaf({ env, station }: CommandContext): Promise<Response> {
  const raw = await cachedTaf(env, station);
  if (!raw) {
    return message(
      `No forecast (TAF) found for \`${station}\`. Only larger airports issue them, so try a bigger airport nearby.`,
      true,
    );
  }
  try {
    return embed(tafEmbed(parseTaf(raw)));
  } catch (err) {
    logEvent("error", "taf_decode_failed", { raw, ...errorFields(err) });
    return message(codeBlock(raw));
  }
}

async function handleCrosswind({ env, station }: CommandContext): Promise<Response> {
  // The two lookups don't depend on each other, so run them at the same time.
  const [raw, airportData] = await Promise.all([cachedMetar(env, station), cachedAirport(env, station)]);
  if (!raw) return message(`No recent METAR found for \`${station}\`, so there's no wind to work with.`, true);
  if (!airportData) return message(`No runway data found for \`${station}\`.`, true);

  const metar = parseMetar(raw);
  const airport = parseAirport(airportData);
  const winds = metar.wind ? runwayWinds(airport, metar.wind) : [];
  return embed(crosswindEmbed(airport, metar, winds));
}

/** Reads a named option from a slash command, e.g. option(interaction, "airport"). */
function option(interaction: any, name: string): string | undefined {
  const found = (interaction.data?.options ?? []).find((o: any) => o.name === name);
  return found === undefined ? undefined : String(found.value);
}

/** Discord puts the user in a different place for server commands and DMs. */
const userIdOf = (interaction: any): string | undefined => interaction.member?.user?.id ?? interaction.user?.id;

/**
 * Can the bot post alerts in the channel this command came from?
 * Yes in a DM with the bot, and in servers the bot was added to.
 * No when someone who installed the app for themselves uses it in a server
 * or group chat the bot isn't in: the bot has no way to post there later.
 */
function canPostAlertsHere(interaction: any): boolean {
  const BOT_DM = 1;
  const GUILD_INSTALL = "0";
  if (interaction.context === BOT_DM) return true;
  if (!interaction.guild_id) return false;
  const owners = interaction.authorizing_integration_owners;
  return owners ? GUILD_INSTALL in owners : true;
}

async function handleSubscribe({ env, interaction, station }: CommandContext): Promise<Response> {
  const userId = userIdOf(interaction);
  const channelId: string | undefined = interaction.channel_id ?? interaction.channel?.id;
  if (!userId || !channelId) return message("I couldn't tell who or where you are. Try again.", true);

  if (!canPostAlertsHere(interaction)) {
    return message(
      "I can't post alerts in this chat. Use `/subscribe` in a server I've been added to, or in a direct message with me.",
      true,
    );
  }

  const requested = (option(interaction, "condition") ?? "IFR").toUpperCase();
  if (!(requested in THRESHOLD_TEXT)) return message("Choose MVFR, IFR or LIFR.", true);
  const threshold = requested as Threshold;

  // Fetch the current report first. It proves the airport exists and reports
  // weather, and gives us a starting point to compare against.
  const raw = await fetchRawMetar(station);
  if (!raw) return message(`\`${station}\` has no weather reports, so I can't send alerts for it.`, true);

  const existing = await subscriptionsForUser(env.DB, userId);
  const alreadyHere = existing.some((s) => s.station === station && s.channelId === channelId);
  if (!alreadyHere && existing.length >= MAX_SUBSCRIPTIONS_PER_USER) {
    return message(
      `You already have ${MAX_SUBSCRIPTIONS_PER_USER} alerts, which is the limit. Remove one with \`/unsubscribe\` first.`,
      true,
    );
  }

  await saveSubscription(env.DB, { userId, channelId, station, threshold });

  let current = "";
  try {
    const metar = parseMetar(raw);
    if (metar.flightCategory) {
      await rememberStateIfNew(env.DB, { station, category: metar.flightCategory, raw });
      current = ` Right now it's ${metar.flightCategory}.`;
    }
  } catch {
    // An undecodable report doesn't stop the subscription; the scheduled job will try again.
  }

  return message(
    `Alert set. I'll post here when **${station}** changes to ${THRESHOLD_TEXT[threshold]}, and when it improves again.${current}`,
  );
}

async function handleUnsubscribe({ env, interaction, station }: CommandContext): Promise<Response> {
  const userId = userIdOf(interaction);
  const channelId: string | undefined = interaction.channel_id ?? interaction.channel?.id;
  if (!userId || !channelId) return message("I couldn't tell who or where you are. Try again.", true);

  const removed = await deleteSubscription(env.DB, userId, channelId, station);
  return message(
    removed
      ? `Removed your **${station}** alert in this channel.`
      : `You don't have a **${station}** alert in this channel. Use \`/alerts\` to see where your alerts are.`,
    true,
  );
}

async function handleAlerts({ env, interaction }: CommandContext): Promise<Response> {
  const userId = userIdOf(interaction);
  if (!userId) return message("I couldn't tell who you are. Try again.", true);

  const subs = await subscriptionsForUser(env.DB, userId);
  if (subs.length === 0) {
    return message("You have no alerts. Set one with `/subscribe`, for example `/subscribe KSAN`.", true);
  }
  const lines = subs.map((s) => `• **${s.station}**: ${THRESHOLD_TEXT[s.threshold]}, posted in <#${s.channelId}>`);
  return message(`Your alerts (${subs.length} of ${MAX_SUBSCRIPTIONS_PER_USER}):\n${lines.join("\n")}`, true);
}

interface Command {
  handler: (ctx: CommandContext) => Promise<Response>;
  /** False for commands that don't take an airport code. */
  needsAirport: boolean;
}

const COMMANDS: Record<string, Command> = {
  metar: { handler: handleMetar, needsAirport: true },
  taf: { handler: handleTaf, needsAirport: true },
  crosswind: { handler: handleCrosswind, needsAirport: true },
  subscribe: { handler: handleSubscribe, needsAirport: true },
  unsubscribe: { handler: handleUnsubscribe, needsAirport: true },
  alerts: { handler: handleAlerts, needsAirport: false },
};

async function handleCommand(interaction: any, env: Env): Promise<Response> {
  const command = COMMANDS[interaction.data?.name];
  if (!command) return message("Unknown command.", true);

  let station = "";
  if (command.needsAirport) {
    const input = option(interaction, "airport") ?? "";
    const normalized = normalizeStationId(input);
    if (!normalized) {
      return message(
        `\`${input}\` doesn't look like an airport code. Try a 4-letter ICAO code like \`KSAN\`.`,
        true,
      );
    }
    station = normalized;
  }

  const name: string = interaction.data.name;
  const started = Date.now();
  try {
    const response = await command.handler({ env, interaction, station });
    logEvent("info", "command", { command: name, station, ms: Date.now() - started });
    return response;
  } catch (err) {
    logEvent("error", "command_failed", { command: name, station, ms: Date.now() - started, ...errorFields(err) });
    return message(
      err instanceof WeatherApiError
        ? "The weather service is slow or not responding. Try again in a minute."
        : "Something went wrong on my side. Try again in a minute.",
      true,
    );
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Aviation weather bot is running.", { status: 200 });
    }

    // Read the body as text first: the signature is computed over the exact bytes.
    const body = await request.text();
    const valid = await verifyDiscordRequest(request, body, env.DISCORD_PUBLIC_KEY);
    if (!valid) {
      return new Response("Bad request signature.", { status: 401 });
    }

    const interaction = JSON.parse(body);

    // Discord pings the endpoint when you save the Interactions Endpoint URL.
    if (interaction.type === PING) {
      return json({ type: PONG });
    }

    if (interaction.type === APPLICATION_COMMAND) {
      return handleCommand(interaction, env);
    }

    return json({ error: "Unsupported interaction type." }, 400);
  },

  /**
   * Runs on the schedule set in wrangler.jsonc (every 5 minutes).
   * waitUntil keeps the Worker alive until the check has finished.
   */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const started = Date.now();
    ctx.waitUntil(
      (async () => {
        try {
          const result = await runAlertCheck({ db: env.DB, botToken: env.DISCORD_BOT_TOKEN });
          await purgeExpiredCache(env.DB);
          logEvent("info", "alert_check", { ...result, ms: Date.now() - started });
        } catch (err) {
          logEvent("error", "alert_check_failed", { ms: Date.now() - started, ...errorFields(err) });
        }
      })(),
    );
  },
};
