-- Link a refresh-token family back to the grant that authorized it (both flows).
-- A future "revoke this one device" ticket needs to kill exactly the sessions a
-- single grant minted; today's client-wide revoke (`revoke_grant_and_expire_
-- client_families`) is too broad for that. This column is the plumbing for it.
--
-- Nullable and NOT a foreign key on purpose: families outlive grants by design —
-- revocation expires a family in place (pulls `expires_at` back), it never
-- deletes the row, and a family can outlive the grant it came from. `grant_id`
-- is written at family-creation time for grants that exist; it is read by nothing
-- in v1.
ALTER TABLE refresh_token_families ADD COLUMN grant_id TEXT;

CREATE INDEX refresh_token_families_grant_id_idx
    ON refresh_token_families(grant_id);
