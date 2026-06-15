-- Singleton tunnel settings row (id is always 'tunnel'). Holds the host
-- intent (subdomain / root_domain / requested_running) plus the relay
-- connection settings the rathole client dials. Relay settings start NULL
-- ("empty for now") and are set through the API; there is no UI and no
-- environment-variable seeding.
CREATE TABLE tunnel_settings (
    id                TEXT PRIMARY KEY,
    subdomain         TEXT,
    root_domain       TEXT,
    requested_running INTEGER NOT NULL DEFAULT 0,
    relay_remote_addr TEXT,
    relay_token       TEXT,
    relay_public_key  TEXT,
    service_name      TEXT
) STRICT;
