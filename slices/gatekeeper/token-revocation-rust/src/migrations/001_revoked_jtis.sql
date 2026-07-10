-- Per-token revocation denylist. A token's `jti` (RFC 7519 §4.1.7) is inserted
-- here the instant it is explicitly revoked (logout, or the owner revocation
-- endpoint); a validated token whose `jti` matches a row here is rejected
-- before its `exp`. `expires_at` mirrors the token's own `exp` (Unix epoch
-- seconds) — a sweep hint so a row can be reclaimed once the token would have
-- expired anyway. It is caller-supplied on the owner endpoint, so the sweep does
-- NOT trust it alone: `revoked_at` (also epoch seconds) is the retention floor —
-- a row is purged only once BOTH `expires_at` has passed and it was revoked at
-- least the longest access-token TTL ago, so a too-early `expires_at` can never
-- drop a still-live token's row (see `RevocationStore::purge_expired`). `reason`
-- is audit-only.
CREATE TABLE revoked_jtis (
    jti TEXT PRIMARY KEY NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER NOT NULL,
    reason TEXT
) STRICT;

-- Supports the expiry sweep's `expires_at < now` range scan.
CREATE INDEX revoked_jtis_expires_at_idx ON revoked_jtis(expires_at);
