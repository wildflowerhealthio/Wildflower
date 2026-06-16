-- The apps catalogue. One table keyed by app id covers both bundled and
-- custom entries: bundled rows only use `enabled` (and the seeded static
-- columns the registry pulls from); custom rows additionally carry
-- `custom_name`, `custom_url`, and `custom_requires_tunnel`. Removing a
-- custom entry deletes the row; "removing" a bundled entry just flips
-- `enabled` to 0. Mirrors the TS livestore `AppSelection` shape.
--
-- `kind` is one of:
--   * 'bundled' — a code-defined static app shown verbatim from the registry
--   * 'action'  — a code-defined static app whose launch is a no-op redirect
--                 to the served origin (e.g. the FHIR Sharing toggle)
--   * 'custom'  — a user-defined entry; the custom_* columns are NOT NULL
--                 for these rows and the registry has no entry by this id.
CREATE TABLE apps (
    id                     TEXT PRIMARY KEY,
    kind                   TEXT NOT NULL CHECK (kind IN ('bundled', 'action', 'custom')),
    enabled                INTEGER NOT NULL DEFAULT 1,
    custom_name            TEXT,
    custom_url             TEXT,
    custom_requires_tunnel INTEGER
) STRICT;

-- A custom row must have its custom_* fields populated; a bundled/action row
-- must not. Belt-and-braces — the Rust write path enforces the same, but the
-- check guards against an out-of-band INSERT (e.g. a future migration) that
-- forgets the invariant.
CREATE TRIGGER apps_custom_columns_match_kind_insert
BEFORE INSERT ON apps
FOR EACH ROW
BEGIN
    SELECT RAISE(ABORT, 'custom apps require custom_name, custom_url, custom_requires_tunnel')
    WHERE NEW.kind = 'custom'
      AND (NEW.custom_name IS NULL
           OR NEW.custom_url IS NULL
           OR NEW.custom_requires_tunnel IS NULL);
    SELECT RAISE(ABORT, 'bundled/action apps must not carry custom_* columns')
    WHERE NEW.kind IN ('bundled', 'action')
      AND (NEW.custom_name IS NOT NULL
           OR NEW.custom_url IS NOT NULL
           OR NEW.custom_requires_tunnel IS NOT NULL);
END;

CREATE TRIGGER apps_custom_columns_match_kind_update
BEFORE UPDATE ON apps
FOR EACH ROW
BEGIN
    SELECT RAISE(ABORT, 'custom apps require custom_name, custom_url, custom_requires_tunnel')
    WHERE NEW.kind = 'custom'
      AND (NEW.custom_name IS NULL
           OR NEW.custom_url IS NULL
           OR NEW.custom_requires_tunnel IS NULL);
    SELECT RAISE(ABORT, 'bundled/action apps must not carry custom_* columns')
    WHERE NEW.kind IN ('bundled', 'action')
      AND (NEW.custom_name IS NOT NULL
           OR NEW.custom_url IS NOT NULL
           OR NEW.custom_requires_tunnel IS NOT NULL);
END;

-- Seed the bundled / action registry. These are the apps every install
-- ships with; the seed is idempotent (INSERT OR IGNORE) so re-running this
-- migration after a hand-edit doesn't error and an enabled-flag flip from
-- the API is preserved.
INSERT OR IGNORE INTO apps (id, kind, enabled) VALUES
    ('fhir-sharing',      'action',  1),
    ('patient-browser',   'bundled', 1),
    ('api-view',          'bundled', 1),
    ('api-docs',          'bundled', 1),
    ('growth-chart',      'bundled', 1),
    ('medication-viewer', 'bundled', 1);
