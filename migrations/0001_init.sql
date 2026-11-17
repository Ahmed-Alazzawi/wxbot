-- Who wants to be alerted about which airport, and where to post the alert.
CREATE TABLE IF NOT EXISTS subscriptions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  station    TEXT NOT NULL,
  -- Alert when the airport is at this flight category or worse.
  threshold  TEXT NOT NULL CHECK (threshold IN ('MVFR', 'IFR', 'LIFR')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- One subscription per person, per channel, per airport.
  UNIQUE (user_id, channel_id, station)
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_station ON subscriptions (station);

-- The last flight category we saw at each airport, so the scheduled job can
-- tell when it changes.
CREATE TABLE IF NOT EXISTS station_state (
  station    TEXT PRIMARY KEY,
  category   TEXT NOT NULL CHECK (category IN ('VFR', 'MVFR', 'IFR', 'LIFR')),
  raw        TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
