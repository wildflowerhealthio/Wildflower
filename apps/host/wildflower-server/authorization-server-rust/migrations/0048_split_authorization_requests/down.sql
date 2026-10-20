-- Reverse of up.sql: one table again, every flow's columns side by side and
-- the flow in `grant_type`, with both `user_code` indexes. Every row of both
-- tables is copied back as it is; the columns a flow doesn't have are null,
-- or their old defaults.
CREATE TABLE authorization_requests (
    id TEXT PRIMARY KEY NOT NULL,
    grant_type TEXT NOT NULL,
    client_id TEXT NOT NULL,
    requested_scopes TEXT NOT NULL,
    code_challenge TEXT,
    redirect_uri TEXT,
    client_state TEXT,
    user_code TEXT,
    pre_approved_scopes TEXT NOT NULL DEFAULT '[]',
    requested_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_polled_at TEXT,
    status TEXT NOT NULL,
    granted_scopes TEXT,
    patient TEXT,
    device_name TEXT,
    launch TEXT,
    launch_bound_patient TEXT,
    decidable_in_requesting_browser INTEGER NOT NULL DEFAULT 0,
    sid TEXT
) STRICT;

CREATE INDEX authorization_requests_user_code_idx
    ON authorization_requests(user_code);
CREATE UNIQUE INDEX authorization_requests_pending_user_code_uidx
    ON authorization_requests(user_code)
    WHERE status = 'pending' AND user_code IS NOT NULL;

INSERT INTO authorization_requests
    (id, grant_type, client_id, requested_scopes, code_challenge, redirect_uri, client_state,
     pre_approved_scopes, requested_at, expires_at, status, granted_scopes, patient, launch,
     launch_bound_patient, decidable_in_requesting_browser, sid)
SELECT id, 'authorization_code', client_id, requested_scopes, code_challenge, redirect_uri,
       client_state, pre_approved_scopes, requested_at, expires_at, status, granted_scopes,
       patient, launch, launch_bound_patient, decidable_in_requesting_browser, sid
  FROM code_authorization_requests;

INSERT INTO authorization_requests
    (id, grant_type, client_id, requested_scopes, user_code, requested_at, expires_at,
     last_polled_at, status, granted_scopes, patient, device_name)
SELECT id, flow, client_id, requested_scopes, user_code, requested_at, expires_at,
       last_polled_at, status, granted_scopes, patient, device_name
  FROM user_code_requests;

DROP INDEX user_code_requests_pending_user_code_uidx;
DROP INDEX user_code_requests_user_code_idx;
DROP TABLE user_code_requests;
DROP TABLE code_authorization_requests;
