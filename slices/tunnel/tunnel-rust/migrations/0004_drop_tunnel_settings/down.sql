-- Reverse of `up.sql`: the table `0001_initial_schema` created, with its
-- singleton row. Never run at runtime (the tunnel only ever rolls migrations
-- forward); present because the diesel migration harness expects a `down.sql`
-- per migration.
CREATE TABLE tunnel_settings (
    id                TEXT PRIMARY KEY,
    revision          INTEGER NOT NULL DEFAULT 0,
    public_host       TEXT,
    requested_running INTEGER NOT NULL DEFAULT 0,
    relay_remote_addr TEXT,
    relay_token       TEXT,
    relay_public_key  TEXT,
    service_name      TEXT
) STRICT;

INSERT INTO tunnel_settings (id) VALUES ('tunnel');
