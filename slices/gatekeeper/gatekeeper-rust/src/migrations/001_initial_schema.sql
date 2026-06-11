CREATE TABLE clients (
    client_id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    redirect_uris TEXT NOT NULL,
    allowed_scopes TEXT NOT NULL,
    secret_hash TEXT,
    registered_at TEXT NOT NULL,
    disabled_at TEXT
);

CREATE TABLE signing_keys (
    kid TEXT PRIMARY KEY NOT NULL,
    kty TEXT NOT NULL,
    alg TEXT NOT NULL,
    values_json TEXT NOT NULL,
    is_active INTEGER NOT NULL
);

CREATE TABLE authorization_requests (
    id TEXT PRIMARY KEY NOT NULL,
    grant_type TEXT NOT NULL,
    client_id TEXT NOT NULL,
    requested_scopes TEXT NOT NULL,
    code_challenge TEXT,
    code_challenge_method TEXT,
    redirect_uri TEXT,
    client_state TEXT,
    user_code TEXT,
    pre_approved_scopes TEXT,
    requested_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_polled_at TEXT,
    status TEXT NOT NULL,
    granted_scopes TEXT,
    patient TEXT
);

CREATE INDEX authorization_requests_user_code_idx
    ON authorization_requests(user_code);

CREATE TABLE authorization_codes (
    code TEXT PRIMARY KEY NOT NULL,
    request_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    granted_scopes TEXT NOT NULL,
    patient TEXT,
    issued_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

CREATE INDEX authorization_codes_request_id_idx
    ON authorization_codes(request_id);

CREATE TABLE grants (
    id TEXT PRIMARY KEY NOT NULL,
    client_id TEXT NOT NULL,
    scopes TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    granted_at TEXT NOT NULL,
    last_used_at TEXT,
    patient TEXT
);

CREATE INDEX grants_client_id_redirect_uri_idx
    ON grants(client_id, redirect_uri);
