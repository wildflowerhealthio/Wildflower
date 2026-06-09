pub mod authorization_code;
pub mod authorization_request;
pub mod client;
pub mod db;
pub mod grant;
pub mod local_client_token;
pub mod signing_key;

pub use db::DbResult;

use std::path::Path;

use crate::error::SetupError;
use db::Connection;

#[derive(Clone)]
pub struct GatekeeperStore {
    conn: Connection,
}

impl GatekeeperStore {
    pub async fn open(db_path: &Path) -> Result<Self, SetupError> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(db_path)?;
        let store = Self { conn };
        store.init_schema().await?;
        Ok(store)
    }

    pub async fn open_in_memory() -> Result<Self, SetupError> {
        let conn = Connection::open_in_memory()?;
        let store = Self { conn };
        store.init_schema().await?;
        Ok(store)
    }

    pub fn conn(&self) -> &Connection {
        &self.conn
    }

    async fn init_schema(&self) -> Result<(), SetupError> {
        self.conn
            .call(|c| {
                c.execute_batch(SCHEMA_SQL)?;
                Ok(())
            })
            .await?;
        Ok(())
    }
}

const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS clients (
    clientId TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    redirectUris TEXT NOT NULL,
    allowedScopes TEXT NOT NULL,
    secretHash TEXT,
    registeredAt TEXT NOT NULL,
    disabledAt TEXT
);

CREATE TABLE IF NOT EXISTS signingKeys (
    kid TEXT PRIMARY KEY NOT NULL,
    kty TEXT NOT NULL,
    alg TEXT NOT NULL,
    values_json TEXT NOT NULL,
    isActive INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS authorizationRequests (
    id TEXT PRIMARY KEY NOT NULL,
    grantType TEXT NOT NULL,
    clientId TEXT NOT NULL,
    requestedScopes TEXT NOT NULL,
    codeChallenge TEXT,
    codeChallengeMethod TEXT,
    redirectUri TEXT,
    clientState TEXT,
    userCode TEXT,
    preApprovedScopes TEXT,
    requestedAt TEXT NOT NULL,
    expiresAt TEXT NOT NULL,
    lastPolledAt TEXT,
    status TEXT NOT NULL,
    grantedScopes TEXT,
    patient TEXT
);

CREATE INDEX IF NOT EXISTS authorizationRequests_userCode_idx
    ON authorizationRequests(userCode);

CREATE TABLE IF NOT EXISTS authorizationCodes (
    code TEXT PRIMARY KEY NOT NULL,
    requestId TEXT NOT NULL,
    clientId TEXT NOT NULL,
    redirectUri TEXT NOT NULL,
    codeChallenge TEXT NOT NULL,
    grantedScopes TEXT NOT NULL,
    patient TEXT,
    issuedAt TEXT NOT NULL,
    expiresAt TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS authorizationCodes_requestId_idx
    ON authorizationCodes(requestId);

CREATE TABLE IF NOT EXISTS grants (
    id TEXT PRIMARY KEY NOT NULL,
    clientId TEXT NOT NULL,
    scopes TEXT NOT NULL,
    redirectUri TEXT NOT NULL,
    grantedAt TEXT NOT NULL,
    lastUsedAt TEXT,
    patient TEXT
);

CREATE INDEX IF NOT EXISTS grants_clientId_redirectUri_idx
    ON grants(clientId, redirectUri);

CREATE TABLE IF NOT EXISTS localClientToken (
    id TEXT PRIMARY KEY NOT NULL,
    value TEXT
);
"#;
