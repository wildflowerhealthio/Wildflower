-- Reverse of up.sql: restore `served_host` with 0001's definition, NULL on
-- every row. The column is appended last rather than between `address` and
-- `method`; every reader names its columns, so the order is not observable.

ALTER TABLE logged_requests ADD COLUMN served_host TEXT;
