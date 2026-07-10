-- Per-subject "not-before" lever for *bulk* revocation without keeping a
-- per-issued-jti registry: bumping a subject's `not_before` (Unix epoch
-- seconds) invalidates every token that subject holds whose `iat` predates the
-- bump, in a single row. `subject` is the token's `sub` claim — today the
-- OAuth `client_id`, so an epoch revokes per-client; per-device granularity
-- needs a device/session handle minted into the token, deferred to future work.
-- `updated_at` is audit-only. The bump is monotonic (see `bump_subject_epoch`):
-- a smaller `not_before` never overwrites a larger one, so revocation can't be
-- walked back.
CREATE TABLE revocation_epochs (
    subject TEXT PRIMARY KEY NOT NULL,
    not_before INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
) STRICT;
