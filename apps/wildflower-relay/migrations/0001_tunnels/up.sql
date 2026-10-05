-- Tunnels created through the admin API (`POST /api/tunnels`). Tunnels from
-- `WILDFLOWER_RELAY_TUNNELS` are not stored here. `name` is the tunnel name: a
-- lowercase DNS label, the device's subdomain and its rathole service name.
-- `email` records who the tunnel belongs to. `token` is the tunnel's rathole
-- token and signing key, in plain text because rathole and HMAC both need it,
-- so this file is a secret store like the rendered TOML (mode 0600).
-- `created_at` is Unix epoch seconds.
CREATE TABLE tunnels (
    name TEXT PRIMARY KEY NOT NULL,
    email TEXT NOT NULL,
    token TEXT NOT NULL,
    created_at INTEGER NOT NULL
) STRICT;
