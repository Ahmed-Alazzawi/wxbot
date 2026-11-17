/**
 * METAR decoder: turns a raw current-weather report into structured data.
 *
 * A METAR is a line of space-separated groups in a fixed order:
 *   type, station, time, wind, visibility, weather, clouds, temp/dew point, altimeter, remarks
 * We split the line into tokens and match each token against a pattern for
 * one of those groups. Anything we don't recognise is kept in `unparsed`
 * instead of crashing, because real reports contain plenty of oddities.
 *
 * The wind, visibility, weather and cloud groups are shared with forecasts,
 * so they are decoded in conditions.ts.
 */

import { Conditions, emptyConditions, finishConditions, readConditionToken, resolveReportTime } from "./conditions";

export { decodeWeather, flightCategoryFor } from "./conditions";
export type { CloudLayer, FlightCategory, Visibility, Wind } from "./conditions";

export interface DecodedMetar extends Conditions {
  raw: string;
  type: "METAR" | "SPECI";
  station: string;
  day: number | null;
  hour: number | null;
  minute: number | null;
  auto: boolean;
  corrected: boolean;
  tempC: number | null;
  dewPointC: number | null;
  altimeterInHg: number | null;
  altimeterHpa: number | null;
  /** Tokens before the remarks that the decoder did not recognise. */
  unparsed: string[];
}

export class MetarParseError extends Error {}

const HPA_PER_INHG = 33.8639;

// Everything after one of these is remarks or a forecast trend, not the observation.
const STOP_TOKENS = new Set(["RMK", "NOSIG", "TEMPO", "BECMG"]);

function parseTemperature(value: string | undefined): number | null {
  if (!value || value.includes("/")) return null;
  const n = parseInt(value.replace("M", ""), 10);
  // "M" means minus. Adding 0 avoids returning -0 for "M00".
  return value.startsWith("M") ? -n + 0 : n;
}

export function parseMetar(rawInput: string): DecodedMetar {
  const raw = rawInput.trim().replace(/=$/, "").trim();
  const tokens = raw.split(/\s+/).filter(Boolean);
  let i = 0;

  const result: DecodedMetar = {
    ...emptyConditions(),
    raw,
    type: "METAR",
    station: "",
    day: null,
    hour: null,
    minute: null,
    auto: false,
    corrected: false,
    tempC: null,
    dewPointC: null,
    altimeterInHg: null,
    altimeterHpa: null,
    unparsed: [],
  };

  if (tokens[i] === "METAR" || tokens[i] === "SPECI") {
    result.type = tokens[i] as "METAR" | "SPECI";
    i++;
  }

  if (!tokens[i] || !/^[A-Z][A-Z0-9]{3}$/.test(tokens[i])) {
    throw new MetarParseError(`Not a METAR: no station identifier in "${raw.slice(0, 40)}"`);
  }
  result.station = tokens[i++];

  const time = /^(\d{2})(\d{2})(\d{2})Z$/.exec(tokens[i] ?? "");
  if (time) {
    result.day = Number(time[1]);
    result.hour = Number(time[2]);
    result.minute = Number(time[3]);
    i++;
  }

  while (i < tokens.length) {
    const token = tokens[i];
    if (STOP_TOKENS.has(token)) break;
    let m: RegExpExecArray | null;

    if (token === "AUTO") {
      result.auto = true;
    } else if (token === "COR") {
      result.corrected = true;
    } else if (token === "$" || token === "//") {
      // Maintenance flag / missing-data placeholder: nothing to decode.
    } else if (/^\d{4}[NSEW]{1,2}$/.test(token) || /^R\d{2}[LCR]?\//.test(token) || /^RE[A-Z]+$/.test(token)) {
      // Directional visibility, runway visual range / runway state, recent weather: skipped for now.
    } else if ((m = /^(M?\d{2}|\/\/)\/(M?\d{2}|\/\/)?$/.exec(token))) {
      // Temperature / dew point in Celsius, e.g. 18/17 or M02/M05.
      result.tempC = parseTemperature(m[1]);
      result.dewPointC = parseTemperature(m[2]);
    } else if ((m = /^A(\d{4})$/.exec(token))) {
      result.altimeterInHg = Number(m[1]) / 100;
      result.altimeterHpa = Math.round(result.altimeterInHg * HPA_PER_INHG);
    } else if ((m = /^Q(\d{4})$/.exec(token))) {
      result.altimeterHpa = Number(m[1]);
      result.altimeterInHg = Math.round((result.altimeterHpa / HPA_PER_INHG) * 100) / 100;
    } else {
      const used = readConditionToken(result, tokens, i);
      if (used > 0) {
        i += used;
        continue;
      }
      result.unparsed.push(token);
    }
    i++;
  }

  finishConditions(result);
  return result;
}

/** Works out the full date and time of the observation. */
export function observationTime(metar: DecodedMetar, now: Date = new Date()): Date | null {
  if (metar.day === null || metar.hour === null || metar.minute === null) return null;
  return resolveReportTime(metar.day, metar.hour, metar.minute, now);
}
