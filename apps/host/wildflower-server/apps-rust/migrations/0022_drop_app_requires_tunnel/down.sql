-- Reverse of up.sql: restore `requires_tunnel` with 0001's definition. Every
-- row gets the default `0`; the values the rows held before up.sql ran are not
-- recoverable. The column is appended last; every reader names its columns, so
-- the order is not observable.

ALTER TABLE app_registrations ADD COLUMN requires_tunnel INTEGER NOT NULL DEFAULT 0;
