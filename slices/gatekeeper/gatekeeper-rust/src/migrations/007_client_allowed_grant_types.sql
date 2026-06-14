-- Per-client grant-type allow-list. Previously any registered client could use
-- any grant at /token (authorization_code, refresh_token, device_code) — the
-- Client carried no notion of permitted grants. Add the column; existing rows
-- default to all three supported grants (backward-compatible), and new
-- registrations can restrict it. Enforced at /token (see token_exchange.rs).
ALTER TABLE clients ADD COLUMN allowed_grant_types TEXT NOT NULL
    DEFAULT '["authorization_code","refresh_token","urn:ietf:params:oauth:grant-type:device_code"]';
