/**
 * Crosswind calculator.
 *
 * Wind blowing straight down a runway is a headwind (good for landing).
 * Wind blowing across it is a crosswind (harder). For any wind we split it
 * into those two parts with basic trigonometry:
 *   headwind  = speed x cos(angle between wind and runway)
 *   crosswind = speed x sin(angle between wind and runway)
 *
 * METAR wind directions are relative to true north, so we compare them with
 * each runway's true heading (not the magnetic number painted on it).
 */

import type { Wind } from "./conditions";

export interface RunwayEnd {
  /** The name painted on the runway, e.g. "27" or "09L". */
  name: string;
  /** Direction an aircraft points when using this end, in degrees true. */
  headingTrue: number;
}

export interface Runway {
  /** e.g. "09/27" */
  id: string;
  lengthFt: number | null;
  ends: RunwayEnd[];
}

export interface Airport {
  icaoId: string;
  name: string;
  runways: Runway[];
}

export interface WindComponents {
  /** Positive = headwind, negative = tailwind. Knots. */
  headwindKt: number;
  /** Size of the crosswind in knots (always positive). */
  crosswindKt: number;
  /** Which side the crosswind comes from. Null when there is none. */
  crosswindFrom: "left" | "right" | null;
}

export interface RunwayWind {
  runway: Runway;
  /** The end that faces into the wind. */
  end: RunwayEnd;
  steady: WindComponents;
  /** Same calculation using the gust speed, when gusts are reported. */
  gust: WindComponents | null;
}

const normalize = (degrees: number) => ((degrees % 360) + 360) % 360;

/** "11E" -> 11, "4W" -> -4. East declination is positive. */
export function parseDeclination(value: unknown): number {
  const m = /^(\d+(?:\.\d+)?)([EW])$/.exec(String(value ?? "").trim());
  if (!m) return 0;
  return m[2] === "E" ? Number(m[1]) : -Number(m[1]);
}

/**
 * Converts the airport record from aviationweather.gov into our Airport shape.
 * Each runway arrives as { id: "09/27", dimension: "9401x200", alignment: 106 },
 * where alignment is the true heading of the first-named end.
 */
export function parseAirport(data: any): Airport {
  const declination = parseDeclination(data?.magdec);
  const runways: Runway[] = [];

  for (const rwy of Array.isArray(data?.runways) ? data.runways : []) {
    const names = String(rwy?.id ?? "").split("/");
    // Skip helipads, water runways and anything else that isn't "number + optional L/C/R".
    if (names.length !== 2 || !names.every((n) => /^\d{1,2}[LCR]?$/.test(n))) continue;

    const alignment = Number(rwy.alignment);
    // If the true heading is missing, estimate it from the runway number
    // (magnetic heading / 10) plus the local magnetic declination.
    const firstHeading =
      rwy.alignment !== null && rwy.alignment !== "" && Number.isFinite(alignment)
        ? alignment
        : parseInt(names[0], 10) * 10 + declination;

    const length = parseInt(String(rwy.dimension ?? "").split("x")[0], 10);
    runways.push({
      id: names.join("/"),
      lengthFt: Number.isFinite(length) ? length : null,
      ends: [
        { name: names[0], headingTrue: normalize(firstHeading) },
        { name: names[1], headingTrue: normalize(firstHeading + 180) },
      ],
    });
  }

  return {
    icaoId: String(data?.icaoId ?? ""),
    name: String(data?.name ?? "").trim(),
    runways,
  };
}

/** Splits a wind into headwind and crosswind for one runway heading. */
export function windComponents(windFrom: number, speedKt: number, runwayHeading: number): WindComponents {
  const angle = ((windFrom - runwayHeading) * Math.PI) / 180;
  const headwindKt = Math.round(speedKt * Math.cos(angle)) + 0; // "+ 0" turns -0 into 0
  const cross = speedKt * Math.sin(angle);
  // Round the size, not the signed value, so left and right round the same way.
  const crosswindKt = Math.round(Math.abs(cross));
  return {
    headwindKt,
    crosswindKt,
    // Positive sine means the wind is clockwise of the runway heading: from the right.
    crosswindFrom: crosswindKt === 0 ? null : cross > 0 ? "right" : "left",
  };
}

/**
 * For each runway, picks the end facing into the wind and works out its
 * headwind and crosswind. Sorted with the smallest crosswind first.
 * Returns an empty list when the wind has no single direction (calm or variable).
 */
export function runwayWinds(airport: Airport, wind: Wind): RunwayWind[] {
  if (typeof wind.direction !== "number" || wind.speedKt === 0) return [];
  const direction = wind.direction;

  return airport.runways
    .map((runway) => {
      const [a, b] = runway.ends.map((end) => ({
        end,
        steady: windComponents(direction, wind.speedKt, end.headingTrue),
      }));
      const best = a.steady.headwindKt >= b.steady.headwindKt ? a : b;
      return {
        runway,
        end: best.end,
        steady: best.steady,
        gust: wind.gustKt !== null ? windComponents(direction, wind.gustKt, best.end.headingTrue) : null,
      };
    })
    .sort((x, y) => x.steady.crosswindKt - y.steady.crosswindKt || y.steady.headwindKt - x.steady.headwindKt);
}
