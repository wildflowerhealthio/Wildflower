//! Tiny PRAGMA user_version migration runner. Each entry of
//! [`MIGRATIONS`] runs at most once, in order; the index of the highest
//! applied entry is persisted in `PRAGMA user_version`. Reproduces what
//! we'd get from `rusqlite_migration` — we hand-roll it because no
//! published `rusqlite_migration` version targets rusqlite 0.33 (the
//! version helios-persistence pins).

use rusqlite::Connection;

pub fn migrate(conn: &mut Connection) -> rusqlite::Result<()> {
    let current: u32 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    let tx = conn.transaction()?;
    for (idx, sql) in MIGRATIONS.iter().enumerate().skip(current as usize) {
        tx.execute_batch(sql)?;
        let next = (idx + 1) as u32;
        // The literal is index-derived, not user input.
        tx.execute_batch(&format!("PRAGMA user_version = {next}"))?;
    }
    tx.commit()
}

const MIGRATIONS: &[&str] = &[INITIAL_SCHEMA];

const INITIAL_SCHEMA: &str = r#"
CREATE TABLE clients (
    clientId TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    redirectUris TEXT NOT NULL,
    allowedScopes TEXT NOT NULL,
    secretHash TEXT,
    registeredAt TEXT NOT NULL,
    disabledAt TEXT
);

CREATE TABLE signingKeys (
    kid TEXT PRIMARY KEY NOT NULL,
    kty TEXT NOT NULL,
    alg TEXT NOT NULL,
    values_json TEXT NOT NULL,
    isActive INTEGER NOT NULL
);

CREATE TABLE authorizationRequests (
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

CREATE INDEX authorizationRequests_userCode_idx
    ON authorizationRequests(userCode);

CREATE TABLE authorizationCodes (
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

CREATE INDEX authorizationCodes_requestId_idx
    ON authorizationCodes(requestId);

CREATE TABLE grants (
    id TEXT PRIMARY KEY NOT NULL,
    clientId TEXT NOT NULL,
    scopes TEXT NOT NULL,
    redirectUri TEXT NOT NULL,
    grantedAt TEXT NOT NULL,
    lastUsedAt TEXT,
    patient TEXT
);

CREATE INDEX grants_clientId_redirectUri_idx
    ON grants(clientId, redirectUri);

CREATE TABLE localClientToken (
    id TEXT PRIMARY KEY NOT NULL,
    value TEXT
);
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrate_is_idempotent() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate(&mut conn).unwrap();
        migrate(&mut conn).unwrap();
        let v: u32 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(v as usize, MIGRATIONS.len());
    }

    #[test]
    fn migrate_creates_expected_tables() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate(&mut conn).unwrap();
        let names: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        for expected in [
            "authorizationCodes",
            "authorizationRequests",
            "clients",
            "grants",
            "localClientToken",
            "signingKeys",
        ] {
            assert!(names.iter().any(|n| n == expected), "missing {expected}");
        }
    }
}
