-- Reverse of up.sql: restore `local_only` with 0001's definition. Every row
-- gets the default `0`, the only value a row could hold once 0012 ran. The
-- column is appended last rather than between `url` and `client_id`; every
-- reader names its columns, so the order is not observable.

ALTER TABLE app_registrations ADD COLUMN local_only INTEGER NOT NULL DEFAULT 0;
