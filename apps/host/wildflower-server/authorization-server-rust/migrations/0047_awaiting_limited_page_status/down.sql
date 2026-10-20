-- Reverse of up.sql: the column comes back set on every row, and a request
-- awaiting its limited page is `pending` with it unset again.
ALTER TABLE authorization_requests ADD COLUMN session_shortfall_acknowledged INTEGER NOT NULL DEFAULT 1;

UPDATE authorization_requests
   SET status = 'pending',
       session_shortfall_acknowledged = 0
 WHERE status = 'awaiting_limited_page';
