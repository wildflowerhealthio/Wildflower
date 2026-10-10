-- The cross-kind `grants` VIEW, in its own migration so it can be up/down'd
-- independently of the table schema (0001) — a UNION-ALL projection is edited
-- far more often than the concrete tables it reads.
--
-- Cross-kind reads (the Owner UI's access index, lookups by bare grant id) go
-- through this UNION ALL view: the shared columns, a kind tag, and each kind's
-- payload column NULL for the other kind. Grant ids are UUIDs minted at upsert
-- time, so they are unique across both tables and a by-id read through the view
-- returns at most one row.
CREATE VIEW grants AS
    SELECT id, client_id, scopes, granted_at, last_used_at, patient,
           'authorization_code' AS grant_type,
           redirect_uri,
           NULL AS device_name
    FROM authorization_code_grants
    UNION ALL
    SELECT id, client_id, scopes, granted_at, last_used_at, patient,
           'device_code' AS grant_type,
           NULL AS redirect_uri,
           device_name
    FROM device_grants;
