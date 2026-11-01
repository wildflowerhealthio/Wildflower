-- Name the denylist's two instants for what they are. `revoked_as_of` is when
-- the row takes effect: a token is revoked from that instant on, which may be
-- later than the insert (a replaced session token keeps working through a short
-- grace). `token_expires_at` is the revoked token's own `exp`, the sweep hint.
-- The purge retention floor is `revoked_as_of` plus the longest access-token
-- TTL (see `RevocationStore::purge_expired`).
ALTER TABLE revoked_jtis RENAME COLUMN revoked_at TO revoked_as_of;
ALTER TABLE revoked_jtis RENAME COLUMN expires_at TO token_expires_at;

-- Supports the expiry sweep's `token_expires_at < now` range scan.
DROP INDEX revoked_jtis_expires_at_idx;
CREATE INDEX revoked_jtis_token_expires_at_idx ON revoked_jtis(token_expires_at);
