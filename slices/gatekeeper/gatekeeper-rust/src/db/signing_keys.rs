use rusqlite::Row;

use super::GatekeeperStore;
use crate::db_utils::JsonColumn;
use crate::domain::signing_key::{SigningKey, SigningKeyValues};

impl TryFrom<&Row<'_>> for SigningKey {
    type Error = rusqlite::Error;
    fn try_from(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(SigningKey {
            kid: row.get("kid")?,
            kty: row.get("kty")?,
            alg: row.get("alg")?,
            values: row.get::<_, JsonColumn<SigningKeyValues>>("values_json")?.0,
            is_active: row.get("is_active")?,
        })
    }
}

impl GatekeeperStore {
    pub fn all_signing_keys(&self) -> crate::db::DbResult<Vec<SigningKey>> {
        let conn = self.conn().lock();
        let mut stmt = conn.prepare(
            "SELECT kid, kty, alg, values_json, is_active FROM signing_keys ORDER BY is_active DESC, kid",
        )?;
        let rows: rusqlite::Result<Vec<_>> = stmt
            .query_map([], |row| SigningKey::try_from(row))?
            .collect();
        rows
    }

    pub fn active_signing_key(&self) -> crate::db::DbResult<Option<SigningKey>> {
        let conn = self.conn().lock();
        let mut stmt = conn.prepare(
            "SELECT kid, kty, alg, values_json, is_active FROM signing_keys WHERE is_active = 1 LIMIT 1",
        )?;
        let mut rows = stmt.query([])?;
        match rows.next()? {
            Some(row) => Ok(Some(SigningKey::try_from(row)?)),
            None => Ok(None),
        }
    }

    pub fn insert_signing_key(&self, key: &SigningKey) -> crate::db::DbResult<()> {
        let values = JsonColumn(&key.values);
        self.conn().lock().execute(
            "INSERT INTO signing_keys (kid, kty, alg, values_json, is_active)
             VALUES (:kid, :kty, :alg, :values, :is_active)",
            rusqlite::named_params! {
                ":kid": key.kid,
                ":kty": key.kty,
                ":alg": key.alg,
                ":values": values,
                ":is_active": key.is_active,
            },
        )?;
        Ok(())
    }
}
