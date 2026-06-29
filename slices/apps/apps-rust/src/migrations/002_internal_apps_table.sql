-- HISTORICAL run-once migration. Migration 004 DROPs `internal_apps` and the
-- flat `apps` table and rebuilds into the parent registry + per-kind child
-- tables, so nothing below survives a fresh install past 004 — it exists only so
-- a database that applied 001..003 before 004 shipped replays the same ordered
-- sequence. Do not delete or restructure it.
--
-- What it did at the time: locally-served ("internal") apps got their own table
-- with no `url` column (the host materialized `http://{loopback_host}:{port}/`
-- at read time) and no admin write surface — just the seed below.
--
-- The previous schema seeded `patient-browser` into the (external) `apps`
-- table with an `{origin}/installed-apps/patient-browser/index.html` URL.
-- That row is moved here so the app gets its own dedicated loopback
-- origin. The DELETE is guarded on the original seeded URL so a user who
-- already edited / re-pointed / renamed the row keeps their changes
-- intact: the guard fails and the externals row stays where it is.
CREATE TABLE internal_apps (
    id          TEXT PRIMARY KEY,
    enabled     INTEGER NOT NULL DEFAULT 1,
    name        TEXT NOT NULL,
    subtitle    TEXT,
    port        INTEGER NOT NULL
) STRICT;

INSERT OR IGNORE INTO internal_apps (id, enabled, name, subtitle, port) VALUES
    (
        'patient-browser',
        1,
        'Patient Browser',
        'Browse patient records served from this device.',
        8081
    );

-- Only remove the externals row if it still carries the original seeded
-- URL. A user edit (rename, URL change, etc.) leaves the WHERE clause
-- unmatched, so their row stays and the internal seed above lives
-- alongside it under the shared `patient-browser` id. (Moot post-004,
-- which drops both tables; described for the historical record only.)
DELETE FROM apps
    WHERE id = 'patient-browser'
      AND url = '{origin}/installed-apps/patient-browser/index.html';
