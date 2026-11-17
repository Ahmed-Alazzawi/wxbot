/**
 * Shared weather decoding used by both METARs (current weather) and TAFs (forecasts).
 *
 * Both report types describe conditions with the same coded groups for wind,
 * visibility, weather and clouds. This file decodes those groups once so the
 * METAR and TAF decoders don't each need their own copy.
 */

export type FlightCategory = "VFR" | "MVFR" | "IFR" | "LIFR";

export interface Wind {
  /** Degrees the wind is blowing FROM (true north), or "VRB" for variable. Null if calm. */
  direction: number | "VRB" | null;
  speedKt: number;
  gustKt: number | null;
  /** Set when the direction is swinging between two headings (e.g. 280V060). */
  variableFrom: number | null;
  variableTo: number | null;
}

export interface Visibility {
  /** Visibility in statute miles (converted if the report used metres). */
  miles: number;
  /** Original value in metres, for reports that use metres. */
  meters: number | null;
  /** "less" = below this value (M1/4SM), "more" = at least this value (P6SM, 9999). */
  modifier: "less" | "more" | null;
  /** Human-readable version, e.g. "1 1/2 statute miles". */
  text: string;
}

export interface CloudLayer {
  cover: "FEW" | "SCT" | "BKN" | "OVC" | "VV";
  /** Height of the layer's base in feet above the airport. Null if not reported. */
  baseFt: number | null;
  type: "CB" | "TCU" | null;
}

export interface Conditions {
  wind: Wind | null;
  visibility: Visibility | null;
  /** "Ceiling And Visibility OK": 10 km+ visibility and no significant cloud. */
  cavok: boolean;
  /** Decoded weather, e.g. ["light rain", "mist"]. */
  weather: string[];
  clouds: CloudLayer[];
  /** True when the report explicitly says the sky is clear (CLR, SKC, NSC, NCD). */
  skyClear: boolean;
  /** Lowest broken/overcast layer, in feet. Null means no ceiling. */
  ceilingFt: number | null;
  flightCategory: FlightCategory | null;
  /** What is driving the category, e.g. "ceiling" or "ceiling and visibility". */
  categoryReason: string | null;
}

export function emptyConditions(): Conditions {
  return {
    wind: null,
    visibility: null,
    cavok: false,
    weather: [],
    clouds: [],
    skyClear: false,
    ceilingFt: null,
    flightCategory: null,
    categoryReason: null,
  };
}

const METERS_PER_MILE = 1609.344;
const KT_PER_MPS = 1.943844;
const KT_PER_KMH = 0.539957;

const WEATHER_DESCRIPTORS: Record<string, string> = {
  MI: "shallow",
  PR: "partial",
  BC: "patches of",
  DR: "drifting",
  BL: "blowing",
  SH: "showers",
  TS: "thunderstorm",
  FZ: "freezing",
};

const WEATHER_PHENOMENA: Record<string, string> = {
  DZ: "drizzle",
  RA: "rain",
  SN: "snow",
  SG: "snow grains",
  IC: "ice crystals",
  PL: "ice pellets",
  GR: "hail",
  GS: "small hail",
  UP: "unknown precipitation",
  BR: "mist",
  FG: "fog",
  FU: "smoke",
  VA: "volcanic ash",
  DU: "dust",
  SA: "sand",
  HZ: "haze",
  PY: "spray",
  PO: "dust whirls",
  SQ: "squalls",
  FC: "funnel cloud",
  SS: "sandstorm",
  DS: "dust storm",
};

const WEATHER_PATTERN = new RegExp(
  `^(\\+|-|VC)?((?:${Object.keys(WEATHER_DESCRIPTORS).join("|")})*)((?:${Object.keys(WEATHER_PHENOMENA).join("|")})*)$`,
);

const pairs = (s: string): string[] => s.match(/.{2}/g) ?? [];

/** Decodes one weather group, e.g. "-SHRA" -> "light rain showers". Null if it isn't one. */
export function decodeWeather(token: string): string | null {
  const match = WEATHER_PATTERN.exec(token);
  if (!match) return null;
  const [, intensity, descriptorPart, phenomenaPart] = match;
  const descriptors = pairs(descriptorPart);
  const phenomena = pairs(phenomenaPart);
  if (descriptors.length === 0 && phenomena.length === 0) return null;

  if (intensity === "+" && phenomenaPart === "FC") return "tornado or waterspout";

  let text = phenomena.map((p) => WEATHER_PHENOMENA[p]).join(" and ");
  const strength = intensity === "-" ? "light " : intensity === "+" ? "heavy " : "";
  const isThunderstorm = descriptors.includes("TS");

  for (const d of descriptors) {
    if (d === "TS") continue;
    if (d === "SH") text = text ? `${text} showers` : "showers";
    else text = `${WEATHER_DESCRIPTORS[d]} ${text}`.trim();
  }
  // Intensity goes first ("light freezing drizzle"), but inside a thunderstorm
  // phrase it describes the precipitation ("thunderstorm with heavy rain").
  if (text) text = strength + text;
  if (isThunderstorm) text = text ? `thunderstorm with ${text}` : "thunderstorm";
  if (intensity === "VC") text += " in the vicinity";
  return text;
}

function milesText(whole: number, num: number | null, den: number | null): string {
  const fraction = num !== null ? `${num}/${den}` : "";
  const amount = [whole > 0 || !fraction ? String(whole) : "", fraction].filter(Boolean).join(" ");
  const value = whole + (num !== null && den ? num / den : 0);
  return `${amount} statute ${value > 1 ? "miles" : "mile"}`;
}

/** Applies the standard US flight category rules to a ceiling and visibility. */
export function flightCategoryFor(
  ceilingFt: number | null,
  visibilityMiles: number,
): { category: FlightCategory; reason: string | null } {
  const order: FlightCategory[] = ["VFR", "MVFR", "IFR", "LIFR"];

  let fromCeiling = 0;
  if (ceilingFt !== null) {
    if (ceilingFt < 500) fromCeiling = 3;
    else if (ceilingFt < 1000) fromCeiling = 2;
    else if (ceilingFt <= 3000) fromCeiling = 1;
  }

  let fromVisibility = 0;
  if (visibilityMiles < 1) fromVisibility = 3;
  else if (visibilityMiles < 3) fromVisibility = 2;
  else if (visibilityMiles <= 5) fromVisibility = 1;

  // The worse of the two decides the category.
  const worst = Math.max(fromCeiling, fromVisibility);
  let reason: string | null = null;
  if (worst > 0) {
    const reasons: string[] = [];
    if (fromCeiling === worst) reasons.push("ceiling");
    if (fromVisibility === worst) reasons.push("visibility");
    reason = reasons.join(" and ");
  }
  return { category: order[worst], reason };
}

/**
 * Tries to read the token at position `i` as a wind, visibility, weather or
 * cloud group, and stores the result in `c`.
 * Returns how many tokens it used: 0 means "not one of mine", and 2 happens
 * for visibilities written as two tokens, like "1 1/2SM".
 */
export function readConditionToken(c: Conditions, tokens: string[], i: number): number {
  const token = tokens[i];
  let m: RegExpExecArray | null;

  if ((m = /^(\d{3}|VRB|\/\/\/)(\d{2,3}|\/\/)(?:G(\d{2,3}))?(KT|MPS|KMH)$/.exec(token))) {
    // Wind, e.g. 15037G48KT = from 150 degrees at 37 knots gusting 48.
    if (m[1] !== "///" && m[2] !== "//") {
      const factor = m[4] === "MPS" ? KT_PER_MPS : m[4] === "KMH" ? KT_PER_KMH : 1;
      const speedKt = Math.round(Number(m[2]) * factor);
      c.wind = {
        direction: speedKt === 0 ? null : m[1] === "VRB" ? "VRB" : Number(m[1]),
        speedKt,
        gustKt: m[3] ? Math.round(Number(m[3]) * factor) : null,
        variableFrom: null,
        variableTo: null,
      };
    }
    return 1;
  }

  if ((m = /^(\d{3})V(\d{3})$/.exec(token))) {
    // Variable wind direction, e.g. 280V060.
    if (c.wind) {
      c.wind.variableFrom = Number(m[1]);
      c.wind.variableTo = Number(m[2]);
    }
    return 1;
  }

  if (token === "CAVOK") {
    c.cavok = true;
    c.visibility = { miles: 10000 / METERS_PER_MILE, meters: 9999, modifier: "more", text: "10 km or more" };
    return 1;
  }

  if (!c.visibility && /^\d{1,2}$/.test(token) && (m = /^(\d+)\/(\d+)SM$/.exec(tokens[i + 1] ?? ""))) {
    // Whole number and fraction split across two tokens, e.g. "1 1/2SM".
    const whole = Number(token);
    c.visibility = {
      miles: whole + Number(m[1]) / Number(m[2]),
      meters: null,
      modifier: null,
      text: milesText(whole, Number(m[1]), Number(m[2])),
    };
    return 2;
  }

  if ((m = /^(M|P)?(\d+)(?:\/(\d+))?SM$/.exec(token))) {
    // Visibility in statute miles, e.g. 10SM, 1/4SM, M1/4SM, P6SM.
    const isFraction = m[3] !== undefined;
    const miles = isFraction ? Number(m[2]) / Number(m[3]) : Number(m[2]);
    const modifier = m[1] === "M" ? "less" : m[1] === "P" ? "more" : null;
    const base = isFraction ? milesText(0, Number(m[2]), Number(m[3])) : milesText(Number(m[2]), null, null);
    c.visibility = {
      miles,
      meters: null,
      modifier,
      text: modifier === "less" ? `less than ${base}` : modifier === "more" ? `more than ${base}` : base,
    };
    return 1;
  }

  if (!c.visibility && (m = /^(\d{4})(NDV)?$/.exec(token))) {
    // Visibility in metres (used outside North America). 9999 means 10 km or more.
    const meters = Number(m[1]);
    c.visibility =
      meters === 9999
        ? { miles: 10000 / METERS_PER_MILE, meters, modifier: "more", text: "10 km or more" }
        : {
            miles: meters / METERS_PER_MILE,
            meters,
            modifier: null,
            text: `${meters.toLocaleString("en-US")} m (${(meters / METERS_PER_MILE).toFixed(1)} mi)`,
          };
    return 1;
  }

  if (token === "CLR" || token === "SKC" || token === "NSC" || token === "NCD") {
    c.skyClear = true;
    return 1;
  }

  if ((m = /^(FEW|SCT|BKN|OVC|VV)(\d{3}|\/\/\/)(CB|TCU|\/\/\/)?$/.exec(token))) {
    // Cloud layer, e.g. BKN025 = broken clouds at 2,500 ft (height is in hundreds of feet).
    c.clouds.push({
      cover: m[1] as CloudLayer["cover"],
      baseFt: m[2] === "///" ? null : Number(m[2]) * 100,
      type: m[3] === "CB" || m[3] === "TCU" ? m[3] : null,
    });
    return 1;
  }

  const weather = decodeWeather(token);
  if (weather) {
    c.weather.push(weather);
    return 1;
  }
  return 0;
}

/** True when the report said something about the sky (even "clear"). */
export function skyKnown(c: Conditions): boolean {
  return c.cavok || c.skyClear || c.clouds.length > 0;
}

/** Works out the ceiling and flight category once all tokens have been read. */
export function finishConditions(c: Conditions): void {
  // Ceiling = lowest broken or overcast layer, or vertical visibility into an
  // obscured sky. FEW and SCT layers don't count as a ceiling.
  const ceilings = c.clouds
    .filter((layer) => layer.cover === "BKN" || layer.cover === "OVC" || layer.cover === "VV")
    // An obscured sky with no reported height is treated as a ceiling at the surface.
    .map((layer) => (layer.baseFt === null && layer.cover === "VV" ? 0 : layer.baseFt))
    .filter((ft): ft is number => ft !== null);
  c.ceilingFt = ceilings.length ? Math.min(...ceilings) : null;

  // We only state a category when we know both the visibility and the sky condition.
  if (c.visibility && skyKnown(c)) {
    const { category, reason } = flightCategoryFor(c.ceilingFt, c.visibility.miles);
    c.flightCategory = category;
    c.categoryReason = reason;
  }
}

/**
 * Turns a day-of-month and time from a report into a full date.
 * Reports don't include the month, so we pick the month (previous, current
 * or next) that puts the time closest to now.
 */
export function resolveReportTime(day: number, hour: number, minute: number, now: Date): Date {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const candidates = [-1, 0, 1].map((offset) => new Date(Date.UTC(year, month + offset, day, hour, minute)));
  return candidates.reduce((best, d) =>
    Math.abs(d.getTime() - now.getTime()) < Math.abs(best.getTime() - now.getTime()) ? d : best,
  );
}
