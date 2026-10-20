-- A code request waiting on its browser's limited page has its own status,
-- `awaiting_limited_page`, rather than `pending` with
-- `session_shortfall_acknowledged` unset: `pending` means waiting for the
-- Owner. Such a request is rewritten to the new status, and the column goes.
-- Every other row keeps its status: an acknowledged code request, and every
-- device request and browser pairing, which always had the column set.
--
-- The partial unique index on a pending `user_code` still reads
-- `status = 'pending'`: a request awaiting the limited page is a code request,
-- which has no `user_code`.
UPDATE authorization_requests
   SET status = 'awaiting_limited_page'
 WHERE grant_type = 'authorization_code'
   AND status = 'pending'
   AND session_shortfall_acknowledged = 0;

-- SQLite's in-place `DROP COLUMN` (3.35+) applies: the column is in no index,
-- key or CHECK.
ALTER TABLE authorization_requests DROP COLUMN session_shortfall_acknowledged;
