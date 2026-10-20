-- Authorization requests split by how they are keyed. A code request is keyed
-- by its id and carries the code flow's columns; a device request or browser
-- pairing is keyed by the `user_code` the Owner enters, and its poll claims
-- the approval. Each table holds only its own columns, NOT NULL wherever its
-- requests always have them, with CHECKs on the statuses it holds and on the
-- approval columns (`granted_scopes`, and `patient` beside it), which are set
-- exactly while a request carries an approval.
--
-- Every row is copied as it is, ids and timestamps unchanged, into the table
-- of its flow; `grant_type` becomes `flow` in `user_code_requests`, and the
-- code table needs none. No foreign key names `authorization_requests`
-- (`authorization_codes.request_id` names a code request by its id, which the
-- copy keeps), and no view reads it.
CREATE TABLE code_authorization_requests (
    id TEXT PRIMARY KEY NOT NULL,
    client_id TEXT NOT NULL,
    requested_scopes TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    status TEXT NOT NULL
        CHECK (status IN ('awaiting_limited_page', 'pending', 'approved', 'denied')),
    granted_scopes TEXT,
    patient TEXT,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    client_state TEXT NOT NULL,
    sid TEXT NOT NULL,
    launch TEXT,
    launch_bound_patient TEXT,
    pre_approved_scopes TEXT NOT NULL,
    decidable_in_requesting_browser INTEGER NOT NULL,
    CHECK ((status = 'approved') = (granted_scopes IS NOT NULL)),
    CHECK (patient IS NULL OR granted_scopes IS NOT NULL)
) STRICT;

-- `device_name` is the requester's name: a device's, or a pairing browser's,
-- which a pairing always has. A pairing's approval binds no patient.
CREATE TABLE user_code_requests (
    id TEXT PRIMARY KEY NOT NULL,
    flow TEXT NOT NULL CHECK (flow IN ('device_code', 'browser_pairing')),
    client_id TEXT NOT NULL,
    requested_scopes TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'claimed')),
    granted_scopes TEXT,
    patient TEXT,
    user_code TEXT NOT NULL,
    device_name TEXT,
    last_polled_at TEXT,
    CHECK ((status IN ('approved', 'claimed')) = (granted_scopes IS NOT NULL)),
    CHECK (patient IS NULL OR granted_scopes IS NOT NULL),
    CHECK (flow = 'device_code' OR (device_name IS NOT NULL AND patient IS NULL))
) STRICT;

-- The device page looks a request up by its `user_code`. Only one pending
-- request holds a code at a time; a decided or claimed one may share it.
CREATE INDEX user_code_requests_user_code_idx
    ON user_code_requests(user_code);
CREATE UNIQUE INDEX user_code_requests_pending_user_code_uidx
    ON user_code_requests(user_code)
    WHERE status = 'pending';

INSERT INTO code_authorization_requests
    (id, client_id, requested_scopes, requested_at, expires_at, status, granted_scopes,
     patient, redirect_uri, code_challenge, client_state, sid, launch, launch_bound_patient,
     pre_approved_scopes, decidable_in_requesting_browser)
SELECT id, client_id, requested_scopes, requested_at, expires_at, status, granted_scopes,
       patient, redirect_uri, code_challenge, client_state, sid, launch, launch_bound_patient,
       pre_approved_scopes, decidable_in_requesting_browser
  FROM authorization_requests
 WHERE grant_type = 'authorization_code';

INSERT INTO user_code_requests
    (id, flow, client_id, requested_scopes, requested_at, expires_at, status, granted_scopes,
     patient, user_code, device_name, last_polled_at)
SELECT id, grant_type, client_id, requested_scopes, requested_at, expires_at, status,
       granted_scopes, patient, user_code, device_name, last_polled_at
  FROM authorization_requests
 WHERE grant_type IN ('device_code', 'browser_pairing');

DROP INDEX authorization_requests_pending_user_code_uidx;
DROP INDEX authorization_requests_user_code_idx;
DROP TABLE authorization_requests;
