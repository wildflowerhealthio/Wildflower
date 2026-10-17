-- Every authorization-code request is made in a browser session:
-- `/oauth/authorize` sends a browser without one to pairing, so each code-flow
-- request, code and refresh family names the `sid` of the browser that made
-- it, and revoking that session ends them. This ends what the code flow
-- holds with no session, which no revocation could reach. Device-flow
-- families (`authorization_code_hash IS NULL`) carry no session by design and
-- keep going. Timestamps are the diesel chrono text encoding
-- (`%F %T%.f%:z`), always in UTC, so they compare as text.

-- End every live refresh family the code flow minted with no session, with
-- `expire_refresh_token_family`'s semantics: each unconsumed token in it is
-- stamped consumed, and the family's `expires_at` is pulled back to the same
-- instant. A family already dead (`expires_at` at or before now) is left as
-- it is. `now` is read once, so both stamps carry the same instant.
CREATE TEMP TABLE migration_now AS
    SELECT strftime('%Y-%m-%d %H:%M:%f', 'now') || '+00:00' AS now;

UPDATE refresh_tokens
   SET consumed_at = (SELECT now FROM migration_now)
 WHERE consumed_at IS NULL
   AND family_id IN (
       SELECT family_id
         FROM refresh_token_families
        WHERE authorization_code_hash IS NOT NULL
          AND sid IS NULL
          AND expires_at > (SELECT now FROM migration_now)
   );
UPDATE refresh_token_families
   SET expires_at = (SELECT now FROM migration_now)
 WHERE authorization_code_hash IS NOT NULL
   AND sid IS NULL
   AND expires_at > (SELECT now FROM migration_now);

DROP TABLE migration_now;

-- A pending code-flow request with no session can no longer be decided:
-- expire it, as its five minutes would.
UPDATE authorization_requests
   SET status = 'expired'
 WHERE grant_type = 'authorization_code'
   AND sid IS NULL
   AND status = 'pending';

-- Every authorization code names its session: `sid` becomes NOT NULL. An
-- unredeemed code issued with no session would start a family with none, so
-- it is dropped; codes live sixty seconds. SQLite can't add NOT NULL to a
-- column in place, so the table is rebuilt and its other rows copied across.
-- Nothing references `authorization_codes` with a foreign key.
CREATE TABLE authorization_codes_new (
    code TEXT PRIMARY KEY NOT NULL,
    request_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    granted_scopes TEXT NOT NULL,
    patient TEXT,
    issued_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    sid TEXT NOT NULL
) STRICT;

INSERT INTO authorization_codes_new
    (code, request_id, client_id, redirect_uri, code_challenge, granted_scopes, patient,
     issued_at, expires_at, sid)
SELECT code, request_id, client_id, redirect_uri, code_challenge, granted_scopes, patient,
       issued_at, expires_at, sid
  FROM authorization_codes
 WHERE sid IS NOT NULL;

DROP TABLE authorization_codes;

ALTER TABLE authorization_codes_new RENAME TO authorization_codes;

CREATE UNIQUE INDEX authorization_codes_request_id_idx
    ON authorization_codes(request_id);
