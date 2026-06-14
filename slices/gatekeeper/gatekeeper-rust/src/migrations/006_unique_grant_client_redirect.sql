-- One standing grant per (client_id, redirect_uri). `upsert_grant` reads the
-- existing grant then writes; without uniqueness, two concurrent approvals for
-- the same pair could both insert, and the single-row reader plus delete-by-id
-- revoke would then leave a duplicate grant (and its refresh families) alive
-- after the user revoked consent. Replace the non-unique index with a UNIQUE
-- one; the upsert is also moved into a single transaction (see grants.rs) so
-- the read-merge-write can't interleave.
DROP INDEX grants_client_id_redirect_uri_idx;

CREATE UNIQUE INDEX grants_client_id_redirect_uri_idx
    ON grants(client_id, redirect_uri);
