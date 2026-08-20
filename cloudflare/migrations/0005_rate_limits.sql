-- Spend limits for the AI endpoints.
--
-- /api/* has no authentication, because a workshop with a name-only login has
-- nothing to authenticate against. Ten participants are not the risk. The risk
-- is the URL leaking onto a pay-as-you-go key: one /api/chat request can drive
-- a dozen model calls, and /api/imagine-result bills image generation per call.
-- Nothing in the system currently notices that happening, let alone stops it.
--
-- Why the counter lives here rather than in the Vercel function. A serverless
-- function's memory is per-instance and instances scale out precisely when
-- something is hammering them, so an in-process counter counts a fraction of
-- the traffic and reports everything is fine. A shared counter is the only kind
-- that means anything, and D1 is already a dependency of every AI endpoint that
-- reads the corpus.
--
-- This is a spend limit, not access control. It does not establish who anyone
-- is; it bounds what an anonymous caller can cost. Limits are set well above
-- what a room of ten people generates, so the first thing to hit them is abuse
-- rather than a busy afternoon.

CREATE TABLE IF NOT EXISTS rw_rate_limits (
  -- '<endpoint>:<caller>' — or '<endpoint>:@global' for the ceiling that
  -- applies across all callers at once, which is what actually bounds the bill
  -- when a leak arrives from many addresses.
  bucket       TEXT NOT NULL,

  -- Fixed windows, not a sliding log. A sliding window needs a row per request;
  -- this needs one row per window and answers the only question that matters —
  -- how much has been spent lately — with a single upsert.
  window_start INTEGER NOT NULL,      -- unix seconds, floored to the window

  count        INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL,

  PRIMARY KEY (bucket, window_start)
);

-- For the sweep that discards windows nobody will read again.
CREATE INDEX IF NOT EXISTS idx_rw_rate_limits_window
  ON rw_rate_limits (window_start);
