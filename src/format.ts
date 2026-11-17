/**
 * Turns a decoded METAR into plain English and a Discord "embed"
 * (the formatted card with a coloured stripe down the side).
 */

import type { Conditions, FlightCategory } from "./conditions";
import { skyKnown } from "./conditions";
import { DecodedMetar, observationTime } from "./metar";
import type { DecodedTaf, TafPeriod } from "./taf";
import type { Airport, RunwayWind, WindComponents } from "./crosswind";

// The colours pilots already know from aviation weather maps.
const CATEGORY_COLORS: Record<FlightCategory, number> = {
  VFR: 0x2ecc71, // green
  MVFR: 0x3498db, // blue
  IFR: 0xe74c3c, // red
  LIFR: 0xd63af9, // magenta
};
const UNKNOWN_COLOR = 0x95a5a6; // grey

const CATEGORY_MEANING: Record<FlightCategory, string> = {
  VFR: "good visual flying conditions",
  MVFR: "marginal visual conditions",
  IFR: "instrument conditions",
  LIFR: "low instrument conditions",
};

const COVER_TEXT = {
  FEW: "few clouds",
  SCT: "scattered clouds",
  BKN: "broken clouds",
  OVC: "overcast",
  VV: "sky obscured, vertical visibility",
} as const;

const feet = (ft: number) => `${ft.toLocaleString("en-US")} ft`;
const degrees = (d: number) => `${String(d).padStart(3, "0")}°`;
const toF = (c: number) => Math.round((c * 9) / 5 + 32);
const temperature = (c: number) => `${c}°C (${toF(c)}°F)`;

export function describeWind(metar: Conditions): string {
  const wind = metar.wind;
  if (!wind) return "not reported";
  if (wind.speedKt === 0) return "calm";

  let text =
    wind.direction === "VRB" || wind.direction === null
      ? `variable at ${wind.speedKt} kt`
      : `from ${degrees(wind.direction)} at ${wind.speedKt} kt`;
  if (wind.gustKt !== null) text += `, gusting ${wind.gustKt} kt`;
  if (wind.variableFrom !== null && wind.variableTo !== null) {
    text += `, direction varying ${degrees(wind.variableFrom)} to ${degrees(wind.variableTo)}`;
  }
  return text;
}

export function describeClouds(metar: Conditions): string {
  if (metar.cavok) return "no significant cloud";
  if (metar.clouds.length === 0) return metar.skyClear ? "clear" : "not reported";

  return metar.clouds
    .map((layer) => {
      let text: string = COVER_TEXT[layer.cover];
      text += layer.baseFt !== null ? ` at ${feet(layer.baseFt)}` : " (height not reported)";
      if (layer.type === "CB") text += " (cumulonimbus)";
      if (layer.type === "TCU") text += " (towering cumulus)";
      return text;
    })
    .join(", ");
}

export function describeCategory(metar: DecodedMetar): string {
  if (!metar.flightCategory) return "unknown (the report is missing visibility or cloud data)";
  let text = `${metar.flightCategory}: ${CATEGORY_MEANING[metar.flightCategory]}`;
  if (metar.categoryReason) text += `, because of ${metar.categoryReason}`;
  return text;
}

/** The decoded report as "Label: value" lines. */
export function describeMetar(metar: DecodedMetar, now: Date = new Date()): string[] {
  const lines: string[] = [`**Flight category:** ${describeCategory(metar)}`];

  const observed = observationTime(metar, now);
  if (observed) {
    // Discord renders <t:...> in each reader's own time zone.
    const unix = Math.floor(observed.getTime() / 1000);
    const kind = metar.type === "SPECI" ? " (special report)" : "";
    lines.push(`**Observed:** <t:${unix}:t>, <t:${unix}:R>${kind}`);
  }

  lines.push(`**Wind:** ${describeWind(metar)}`);
  lines.push(`**Visibility:** ${metar.visibility ? metar.visibility.text : "not reported"}`);
  if (metar.weather.length) lines.push(`**Weather:** ${metar.weather.join(", ")}`);
  lines.push(`**Clouds:** ${describeClouds(metar)}`);
  if (metar.ceilingFt !== null) lines.push(`**Ceiling:** ${feet(metar.ceilingFt)}`);
  if (metar.tempC !== null) lines.push(`**Temperature:** ${temperature(metar.tempC)}`);
  if (metar.dewPointC !== null) lines.push(`**Dew point:** ${temperature(metar.dewPointC)}`);
  if (metar.altimeterInHg !== null && metar.altimeterHpa !== null) {
    lines.push(`**Altimeter:** ${metar.altimeterInHg.toFixed(2)} inHg (${metar.altimeterHpa} hPa)`);
  }
  return lines;
}

/** Builds the Discord embed for a decoded METAR. */
export function metarEmbed(metar: DecodedMetar, now: Date = new Date()) {
  return {
    title: `${metar.station} · ${metar.flightCategory ?? "Weather report"}`,
    color: metar.flightCategory ? CATEGORY_COLORS[metar.flightCategory] : UNKNOWN_COLOR,
    description: `${describeMetar(metar, now).join("\n")}\n\`\`\`\n${metar.raw}\n\`\`\``,
    footer: { text: "Not for real flight planning · Data: aviationweather.gov" },
  };
}

// ---------------------------------------------------------------------------
// Forecasts (TAF)
// ---------------------------------------------------------------------------

const CATEGORY_DOTS: Record<FlightCategory, string> = { VFR: "🟢", MVFR: "🔵", IFR: "🔴", LIFR: "🟣" };
const CATEGORY_RANK: FlightCategory[] = ["VFR", "MVFR", "IFR", "LIFR"];
const FOOTER = { text: "Not for real flight planning · Data: aviationweather.gov" };
const DESCRIPTION_LIMIT = 4000; // Discord allows 4,096 characters

const unix = (d: Date) => Math.floor(d.getTime() / 1000);
const clock = (d: Date) => `<t:${unix(d)}:t>`;

/** One line listing only the conditions a forecast period actually mentions. */
export function summarizePeriod(period: TafPeriod): string {
  const parts: string[] = [];
  if (period.wind) parts.push(`wind ${describeWind(period)}`);
  if (period.visibility) parts.push(`visibility ${period.visibility.text}`);
  if (period.weather.length) parts.push(period.weather.join(", "));
  if (period.noSignificantWeather) parts.push("no significant weather");
  if (skyKnown(period)) parts.push(describeClouds(period));
  if (period.windShear) parts.push(period.windShear);
  return parts.join(" · ") || "no details given";
}

export function periodHeading(period: TafPeriod): string {
  const range = period.from && period.to ? `${clock(period.from)} to ${clock(period.to)}` : "";
  const starts = period.from ? ` (<t:${unix(period.from)}:R>)` : "";
  switch (period.kind) {
    case "BASE":
    case "FM":
      return period.from ? `From ${clock(period.from)}${starts}` : "Initially";
    case "BECMG":
      return `Becoming, ${range}${starts}`.trim();
    case "TEMPO":
      return `Temporarily, ${range}${starts}`.trim();
    case "PROB":
      return `${period.probability}% chance, ${range}${starts}`.trim();
  }
}

/** Builds the Discord embed for a decoded TAF. Periods that have already ended are left out. */
export function tafEmbed(taf: DecodedTaf, now: Date = new Date()) {
  const upcoming = taf.periods.filter((p) => !p.to || p.to.getTime() > now.getTime());
  const periods = upcoming.length ? upcoming : taf.periods;

  const worst = periods
    .map((p) => p.flightCategory)
    .filter((c): c is FlightCategory => c !== null)
    .sort((a, b) => CATEGORY_RANK.indexOf(b) - CATEGORY_RANK.indexOf(a))[0];

  const header: string[] = [];
  if (taf.issued) header.push(`**Issued:** <t:${unix(taf.issued)}:R>${taf.amended ? " (amended)" : ""}`);
  if (taf.validTo) header.push(`**Valid until:** <t:${unix(taf.validTo)}:f>`);
  if (worst) header.push(`**Worst expected:** ${worst} (${CATEGORY_MEANING[worst]})`);

  const rawBlock = `\n\`\`\`\n${taf.raw}\n\`\`\``;
  let description = header.join("\n");
  let shown = 0;
  for (const period of periods) {
    const dot = period.flightCategory ? CATEGORY_DOTS[period.flightCategory] : "⚪";
    const category = period.flightCategory ? ` · ${period.flightCategory}` : "";
    const block = `\n\n${dot} **${periodHeading(period)}**${category}\n${summarizePeriod(period)}`;
    if (description.length + block.length + rawBlock.length > DESCRIPTION_LIMIT) break;
    description += block;
    shown++;
  }
  if (shown < periods.length) description += `\n\n…and ${periods.length - shown} more period(s) in the raw forecast.`;
  // Leave the raw text out if a very long forecast would push us over Discord's limit.
  if (description.length + rawBlock.length <= DESCRIPTION_LIMIT) description += rawBlock;

  return {
    title: `${taf.station} forecast`,
    color: worst ? CATEGORY_COLORS[worst] : UNKNOWN_COLOR,
    description,
    footer: FOOTER,
  };
}

// ---------------------------------------------------------------------------
// Crosswind
// ---------------------------------------------------------------------------

function describeComponents(c: WindComponents): string {
  const along =
    c.headwindKt > 0 ? `headwind ${c.headwindKt} kt` : c.headwindKt < 0 ? `tailwind ${-c.headwindKt} kt` : "no headwind";
  const across = c.crosswindFrom ? `crosswind ${c.crosswindKt} kt from the ${c.crosswindFrom}` : "no crosswind";
  return `${along}, ${across}`;
}

/** Builds the Discord embed for /crosswind. */
export function crosswindEmbed(airport: Airport, metar: DecodedMetar, winds: RunwayWind[], now: Date = new Date()) {
  const lines: string[] = [`**Wind:** ${describeWind(metar)}`];
  const observed = observationTime(metar, now);
  if (observed) lines.push(`**Observed:** ${clock(observed)}, <t:${unix(observed)}:R>`);
  lines.push("");

  const wind = metar.wind;
  if (!wind) {
    lines.push("The latest report has no wind reading, so crosswind can't be worked out.");
  } else if (wind.speedKt === 0) {
    lines.push("The wind is calm, so there is no crosswind on any runway.");
  } else if (typeof wind.direction !== "number") {
    const most = wind.gustKt ?? wind.speedKt;
    lines.push(`The wind direction is variable, so any runway could see up to ${most} kt of crosswind.`);
  } else if (winds.length === 0) {
    lines.push("No runway data is available for this airport.");
  } else {
    winds.forEach((rw, index) => {
      const length = rw.runway.lengthFt ? `, ${rw.runway.lengthFt.toLocaleString("en-US")} ft` : "";
      let line = `**Runway ${rw.end.name}** (${rw.runway.id}${length})\n${describeComponents(rw.steady)}`;
      if (rw.gust) line += `\nIn gusts: ${describeComponents(rw.gust)}`;
      if (index === 0 && winds.length > 1) line += "\n*Best aligned with the wind*";
      lines.push(line);
    });
    if (wind.variableFrom !== null) {
      lines.push("", "The wind direction is swinging, so expect these numbers to change.");
    }
  }

  return {
    title: `${airport.icaoId || metar.station} crosswind${airport.name ? ` · ${airport.name}` : ""}`,
    color: 0x5865f2,
    description: lines.join("\n"),
    footer: FOOTER,
  };
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

/** Builds the embed posted when an airport's flight category changes. */
export function alertEmbed(metar: DecodedMetar, previous: FlightCategory, now: Date = new Date()) {
  const current = metar.flightCategory!;
  const worse = CATEGORY_RANK.indexOf(current) > CATEGORY_RANK.indexOf(previous);
  return {
    ...metarEmbed(metar, now),
    title: `${CATEGORY_DOTS[current]} ${metar.station} ${worse ? "dropped" : "improved"} to ${current} (was ${previous})`,
  };
}
