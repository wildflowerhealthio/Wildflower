-- Locally-served apps (internal apps) live in their own table. They have
-- no `url` column on the wire — the host materializes a launch target as
-- `http://{loopback_host}:{port}/` at read time — and they are NOT
-- editable through the admin API: there's no insert/update/delete surface
-- for this table at the moment, just the seed below.
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
-- alongside it — distinct ids would collide but here both rows share
-- `patient-browser`. The READ-time merge (`GET /apps`) prefers the
-- internals row, so a stuck externals row only matters if the user
-- restores it manually.
DELETE FROM apps
    WHERE id = 'patient-browser'
      AND url = '{origin}/installed-apps/patient-browser/index.html';
