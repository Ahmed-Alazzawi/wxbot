/**
 * Talks to the free Aviation Weather Center Data API (aviationweather.gov).
 * No API key is needed.
 */

const API_BASE = "https://aviationweather.gov/api/data";
const REQUEST_HEADERS = { "user-agent": "wxbot-discord (portfolio project)" };

// Discord gives us 3 seconds to answer a command. Giving up on the weather
// service after 2.5 leaves time to send a friendly error instead of nothing.
const TIMEOUT_MS = 2500;

/** Thrown when the weather service fails, times out or can't be reached. */
export class WeatherApiError extends Error {}

async function apiFetch(url: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, { headers: REQUEST_HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new WeatherApiError(`Aviation Weather API unreachable: ${err instanceof Error ? err.message : err}`);
  }
  // 204 No Content is how the API says "nothing for that station".
  if (!response.ok && response.status !== 204) {
    throw new WeatherApiError(`Aviation Weather API returned ${response.status}`);
  }
  return response;
}

/**
 * Cleans up what the user typed into a station ID.
 * "ksan" -> "KSAN". A 3-letter code like "SAN" becomes "KSAN", since US
 * airports' ICAO codes are usually the 3-letter code with a K in front.
 * Returns null if the input can't be an airport code.
 */
export function normalizeStationId(input: string): string | null {
  const id = input.trim().toUpperCase();
  if (/^[A-Z][A-Z0-9]{3}$/.test(id)) return id;
  if (/^[A-Z]{3}$/.test(id)) return "K" + id;
  return null;
}

/**
 * Fetches the latest raw METAR for a station.
 * Returns null when the API has no report for that station.
 * Throws if the API itself fails.
 */
export async function fetchRawMetar(station: string): Promise<string | null> {
  const url = `${API_BASE}/metar?ids=${encodeURIComponent(station)}&format=raw`;
  const response = await apiFetch(url);

  if (response.status === 204) return null;

  const text = (await response.text()).trim();
  if (!text) return null;
  // If several reports come back, the first line is the newest.
  return text.split("\n")[0].trim();
}

/**
 * Fetches the current raw TAF (forecast) for a station.
 * A TAF spans several lines; we return it as one block of text.
 * Returns null when the station has no TAF (many small airports don't).
 */
export async function fetchRawTaf(station: string): Promise<string | null> {
  const url = `${API_BASE}/taf?ids=${encodeURIComponent(station)}&format=raw`;
  const response = await apiFetch(url);
  if (response.status === 204) return null;
  const text = (await response.text()).trim();
  return text || null;
}

/**
 * Fetches airport details, including runways, as JSON.
 * Returns null when the airport isn't in the database.
 */
export async function fetchAirport(station: string): Promise<unknown | null> {
  const url = `${API_BASE}/airport?ids=${encodeURIComponent(station)}&format=json`;
  const response = await apiFetch(url);
  if (response.status === 204) return null;
  const text = (await response.text()).trim();
  if (!text) return null;
  const data = JSON.parse(text);
  return Array.isArray(data) ? (data[0] ?? null) : data;
}

/**
 * Fetches the latest raw METAR for many stations in as few requests as possible.
 * Returns a map of station -> raw report. Stations with no report are left out.
 */
export async function fetchRawMetars(stations: string[]): Promise<Map<string, string>> {
  const CHUNK = 40; // keeps the URL short
  const reports = new Map<string, string>();

  for (let i = 0; i < stations.length; i += CHUNK) {
    const ids = stations.slice(i, i + CHUNK).map(encodeURIComponent).join(",");
    const response = await apiFetch(`${API_BASE}/metar?ids=${ids}&format=raw`);
    if (response.status === 204) continue;

    for (const line of (await response.text()).split("\n")) {
      const report = line.trim();
      // The station is the first 4-character code after an optional METAR/SPECI.
      const station = /^(?:METAR |SPECI )?([A-Z][A-Z0-9]{3})\b/.exec(report)?.[1];
      // Keep only the first (newest) report for each station.
      if (station && !reports.has(station)) reports.set(station, report);
    }
  }
  return reports;
}
