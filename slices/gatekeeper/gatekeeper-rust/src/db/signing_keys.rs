use anyhow::Context;
use rusqlite::Row;

use super::GatekeeperStore;
use crate::crypto_util::signing_key::{
    generate as generate_signing_key, SigningKey, SigningKeyValues,
};
use crate::json::Json;

impl TryFrom<&Row<'_>> for SigningKey {
    type Error = rusqlite::Error;
    fn try_from(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(SigningKey {
            kid: row.get("kid")?,
            kty: row.get("kty")?,
            alg: row.get("alg")?,
            values: row.get::<_, Json<SigningKeyValues>>("values_json")?.0,
            is_active: row.get("isActive")?,
        })
    }
}

impl GatekeeperStore {
    pub fn all_signing_keys(&self) -> crate::db::DbResult<Vec<SigningKey>> {
        let conn = self.conn().lock();
        let mut stmt = conn.prepare(
            "SELECT kid, kty, alg, values_json, isActive FROM signingKeys ORDER BY isActive DESC, kid",
        )?;
        let rows: rusqlite::Result<Vec<_>> = stmt
            .query_map([], |row| SigningKey::try_from(row))?
            .collect();
        rows
    }

    pub fn active_signing_key(&self) -> crate::db::DbResult<Option<SigningKey>> {
        let conn = self.conn().lock();
        let mut stmt = conn.prepare(
            "SELECT kid, kty, alg, values_json, isActive FROM signingKeys WHERE isActive = 1 LIMIT 1",
        )?;
        let mut rows = stmt.query([])?;
        match rows.next()? {
            Some(row) => Ok(Some(SigningKey::try_from(row)?)),
            None => Ok(None),
        }
    }

    pub fn insert_signing_key(&self, key: &SigningKey) -> crate::db::DbResult<()> {
        let values = Json(&key.values);
        self.conn().lock().execute(
            "INSERT INTO signingKeys (kid, kty, alg, values_json, isActive)
             VALUES (:kid, :kty, :alg, :values, :isActive)",
            rusqlite::named_params! {
                ":kid": key.kid,
                ":kty": key.kty,
                ":alg": key.alg,
                ":values": values,
                ":isActive": key.is_active,
            },
        )?;
        Ok(())
    }

    /// Generate and insert an active signing key if the table is empty;
    /// otherwise leave the existing keys alone. Idempotent — safe to call on
    /// every boot.
    pub fn ensure_some_active_signing_key(&self) -> anyhow::Result<()> {
        let existing = self.active_signing_key().context("read signing keys")?;
        if existing.is_some() {
            return Ok(());
        }
        let mut key = generate_signing_key().context("generate signing key")?;
        key.is_active = true;
        self.insert_signing_key(&key)
            .context("insert signing key")?;
        Ok(())
    }
}
