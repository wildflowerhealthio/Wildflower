use rusqlite::{params, Row};

use super::GatekeeperStore;
use crate::crypto::signing_key::{SigningKey, SigningKeyValues};

fn row_to_signing_key(row: &Row) -> rusqlite::Result<SigningKey> {
    let values_json: String = row.get("values_json")?;
    let values: SigningKeyValues =
        serde_json::from_str(&values_json).map_err(|_| rusqlite::Error::InvalidQuery)?;
    Ok(SigningKey {
        kid: row.get("kid")?,
        kty: row.get("kty")?,
        alg: row.get("alg")?,
        values,
    })
}

impl GatekeeperStore {
    pub fn all_signing_keys(&self) -> crate::store::DbResult<Vec<SigningKey>> {
        let conn = self.conn().lock();
        let mut stmt = conn.prepare(
            "SELECT kid, kty, alg, values_json FROM signingKeys ORDER BY isActive DESC, kid",
        )?;
        let rows = stmt
            .query_map([], row_to_signing_key)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn active_signing_key(&self) -> crate::store::DbResult<Option<SigningKey>> {
        let conn = self.conn().lock();
        let mut stmt = conn.prepare(
            "SELECT kid, kty, alg, values_json FROM signingKeys WHERE isActive = 1 LIMIT 1",
        )?;
        let mut rows = stmt.query([])?;
        let result = match rows.next()? {
            Some(row) => Some(row_to_signing_key(row)?),
            None => None,
        };
        Ok(result)
    }

    pub fn insert_signing_key(
        &self,
        key: SigningKey,
        is_active: bool,
    ) -> crate::store::DbResult<()> {
        let values_json = serde_json::to_string(&key.values).unwrap();
        self.conn().lock().execute(
            "INSERT INTO signingKeys (kid, kty, alg, values_json, isActive) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![key.kid, key.kty, key.alg, values_json, is_active as i64],
        )?;
        Ok(())
    }
}
