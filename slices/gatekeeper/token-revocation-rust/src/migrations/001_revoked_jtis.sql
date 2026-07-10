-- Per-token revocation denylist. A token's `jti` (RFC 7519 §4.1.7) is inserted
-- here the instant it is explicitly revoked (logout, or the owner revocation
-- endpoint); a validated token whose `jti` matches a row here is rejected
-- before its `exp`. `expires_at` mirrors the token's own `exp` (Unix epoch
-- seconds) so the background sweep can drop a row once the token would have
-- expired anyway — past `exp` the token is dead by expiry validation regardless,
-- so the denylist row buys nothing. `reason` is audit-only.
CREATE TABLE revoked_jtis (
    jti TEXT PRIMARY KEY NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER NOT NULL,
    reason TEXT
) STRICT;

-- Supports the expiry sweep's `expires_at < now` range delete.
CREATE INDEX revoked_jtis_expires_at_idx ON revoked_jtis(expires_at);
