/**
 * TAF decoder: turns a raw airport forecast into a list of time periods.
 *
 * A TAF starts with a header (station, issue time, validity window) and the
 * conditions expected at the start. After that come change groups:
 *   FM171030          from this time, conditions change completely
 *   BECMG 1703/1705   conditions change gradually during this window
 *   TEMPO 1700/1709   temporary swings during this window
 *   PROB30 1704/1708  30% chance of these conditions during this window
 * Each group uses the same wind / visibility / weather / cloud codes as a
 * METAR, which is why the token decoding lives in conditions.ts.
 */

import {
  Conditions,
  emptyConditions,
  finishConditions,
  flightCategoryFor,
  readConditionToken,
  resolveReportTime,
  skyKnown,
} from "./conditions";

export type TafPeriodKind = "BASE" | "FM" | "BECMG" | "TEMPO" | "PROB";

export interface TafPeriod extends Conditions {
  kind: TafPeriodKind;
  /** Percent chance, for PROB groups. */
  probability: number | null;
  from: Date | null;
  to: Date | null;
  /** NSW: the weather mentioned earlier (rain, fog...) is expected to end. */
  noSignificantWeather: boolean;
  /** Low-level wind shear, already in plain English. */
  windShear: string | null;
}

export interface DecodedTaf {
  raw: string;
  station: string;
  amended: boolean;
  corrected: boolean;
  issued: Date | null;
  validFrom: Date | null;
  validTo: Date | null;
  periods: TafPeriod[];
  /** Tokens before the remarks that the decoder did not recognise. */
  unparsed: string[];
}

export class TafParseError extends Error {}

const VALIDITY = /^(\d{2})(\d{2})\/(\d{2})(\d{2})$/;

function newPeriod(kind: TafPeriodKind): TafPeriod {
  return {
    ...emptyConditions(),
    kind,
    probability: null,
    from: null,
    to: null,
    noSignificantWeather: false,
    windShear: null,
  };
}

export function parseTaf(rawInput: string, now: Date = new Date()): DecodedTaf {
  const raw = rawInput.trim().replace(/=$/, "").trim();
  const tokens = raw.split(/\s+/).filter(Boolean);
  let i = 0;

  const taf: DecodedTaf = {
    raw,
    station: "",
    amended: false,
    corrected: false,
    issued: null,
    validFrom: null,
    validTo: null,
    periods: [],
    unparsed: [],
  };

  // Header: TAF [AMD|COR] station [issue time] [validity]
  while (tokens[i] === "TAF" || tokens[i] === "AMD" || tokens[i] === "COR") {
    if (tokens[i] === "AMD") taf.amended = true;
    if (tokens[i] === "COR") taf.corrected = true;
    i++;
  }
  if (!tokens[i] || !/^[A-Z][A-Z0-9]{3}$/.test(tokens[i])) {
    throw new TafParseError(`Not a TAF: no station identifier in "${raw.slice(0, 40)}"`);
  }
  taf.station = tokens[i++];

  let m = /^(\d{2})(\d{2})(\d{2})Z$/.exec(tokens[i] ?? "");
  if (m) {
    taf.issued = resolveReportTime(Number(m[1]), Number(m[2]), Number(m[3]), now);
    i++;
  }
  // Later times are resolved relative to the issue time, so a forecast that
  // runs into next month still gets the right dates.
  const reference = taf.issued ?? now;
  const window = (match: RegExpExecArray): [Date, Date] => [
    resolveReportTime(Number(match[1]), Number(match[2]), 0, reference),
    resolveReportTime(Number(match[3]), Number(match[4]), 0, reference),
  ];

  m = VALIDITY.exec(tokens[i] ?? "");
  if (m) {
    [taf.validFrom, taf.validTo] = window(m);
    i++;
  }

  let period = newPeriod("BASE");
  period.from = taf.validFrom;
  taf.periods.push(period);

  /** Reads the "ddhh/ddhh" window that follows TEMPO, BECMG and PROB. */
  const readWindow = () => {
    const match = VALIDITY.exec(tokens[i + 1] ?? "");
    if (match) {
      [period.from, period.to] = window(match);
      i++;
    }
  };

  while (i < tokens.length) {
    const token = tokens[i];
    if (token === "RMK") break;

    if ((m = /^FM(\d{2})(\d{2})(\d{2})$/.exec(token))) {
      period = newPeriod("FM");
      period.from = resolveReportTime(Number(m[1]), Number(m[2]), Number(m[3]), reference);
      taf.periods.push(period);
    } else if (token === "TEMPO" || token === "BECMG") {
      period = newPeriod(token);
      taf.periods.push(period);
      readWindow();
    } else if ((m = /^PROB(\d{2})$/.exec(token))) {
      period = newPeriod("PROB");
      period.probability = Number(m[1]);
      taf.periods.push(period);
      if (tokens[i + 1] === "TEMPO") i++; // "PROB30 TEMPO" reads the same as "PROB30" for our purposes
      readWindow();
    } else if (token === "NSW") {
      period.noSignificantWeather = true;
    } else if ((m = /^WS(\d{3})\/(\d{3})(\d{2,3})KT$/.exec(token))) {
      const height = (Number(m[1]) * 100).toLocaleString("en-US");
      period.windShear = `wind shear at ${height} ft (wind from ${m[2]}° at ${Number(m[3])} kt)`;
    } else if (/^QNH\d{4}INS$/.test(token) || /^T[XN]M?\d{2}\/\d{4}Z$/.test(token) || /^[56]\d{5}$/.test(token)) {
      // Military pressure, max/min temperature, icing and turbulence groups: skipped for now.
    } else {
      const used = readConditionToken(period, tokens, i);
      if (used > 0) {
        i += used;
        continue;
      }
      taf.unparsed.push(token);
    }
    i++;
  }

  taf.periods.forEach(finishConditions);

  // End time of each main period = start of the next main period.
  const main = taf.periods.filter((p) => p.kind === "BASE" || p.kind === "FM");
  main.forEach((p, index) => {
    p.to = main[index + 1]?.from ?? taf.validTo;
  });

  // BECMG / TEMPO / PROB groups only list what changes. To give them a flight
  // category we fill the gaps from the conditions prevailing at the time.
  let prevailing = { visibility: taf.periods[0].visibility, skyKnown: false, ceilingFt: null as number | null };
  for (const p of taf.periods) {
    if (p.kind === "BASE" || p.kind === "FM") {
      prevailing = { visibility: p.visibility, skyKnown: skyKnown(p), ceilingFt: p.ceilingFt };
      continue;
    }
    const effective = {
      visibility: p.visibility ?? prevailing.visibility,
      skyKnown: skyKnown(p) || prevailing.skyKnown,
      ceilingFt: skyKnown(p) ? p.ceilingFt : prevailing.ceilingFt,
    };
    if (effective.visibility && effective.skyKnown) {
      const { category, reason } = flightCategoryFor(effective.ceilingFt, effective.visibility.miles);
      p.flightCategory = category;
      p.categoryReason = reason;
    }
    // A BECMG change sticks, so it becomes the new prevailing condition.
    if (p.kind === "BECMG") prevailing = effective;
  }

  return taf;
}
