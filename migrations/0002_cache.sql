-- Short-lived copies of weather API responses, so repeated commands for the
-- same airport don't each make a new request to aviationweather.gov.
CREATE TABLE IF NOT EXISTS api_cache (
  key        TEXT PRIMARY KEY,
  -- NULL means "the API had nothing for this", which is worth remembering too.
  body       TEXT,
  -- Unix time in seconds after which the row is stale.
  expires_at INTEGER NOT NULL
);
