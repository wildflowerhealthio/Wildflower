-- Reverse of up.sql's shape only: `authorization_codes.sid` is nullable
-- again, rebuilt for the same reason and with every row kept. The families
-- up.sql ended stay ended, the requests it expired stay expired, and the
-- codes it dropped stay gone.
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
    sid TEXT
) STRICT;

INSERT INTO authorization_codes_new
    (code, request_id, client_id, redirect_uri, code_challenge, granted_scopes, patient,
     issued_at, expires_at, sid)
SELECT code, request_id, client_id, redirect_uri, code_challenge, granted_scopes, patient,
       issued_at, expires_at, sid
  FROM authorization_codes;

DROP TABLE authorization_codes;

ALTER TABLE authorization_codes_new RENAME TO authorization_codes;

CREATE UNIQUE INDEX authorization_codes_request_id_idx
    ON authorization_codes(request_id);
