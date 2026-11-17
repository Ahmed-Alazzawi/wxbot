/**
 * Structured logging.
 *
 * Each log line is one JSON object, e.g.
 *   {"level":"info","event":"command","command":"metar","station":"KSAN","ms":212}
 * Cloudflare's Workers Logs indexes the fields, so in the dashboard you can
 * filter by event, command or station instead of searching free text.
 * We deliberately never log user IDs or message contents.
 */

type Level = "info" | "error";

export function logEvent(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, event, ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
}

/** Turns anything that was thrown into loggable fields. */
export function errorFields(err: unknown): Record<string, unknown> {
  if (err instanceof Error) return { error: err.message, errorType: err.name, stack: err.stack };
  return { error: String(err) };
}
