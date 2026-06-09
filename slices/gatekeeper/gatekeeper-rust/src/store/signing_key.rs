use anyhow::Context;
use rusqlite::{Row, ToSql};

use super::GatekeeperStore;
use crate::crypto::signing_key::{generate as generate_signing_key, SigningKey};

impl SigningKey {
    pub fn as_named_sql_params(&self) -> [(&str, &dyn ToSql); 5] {
        [
            (":kid", &self.kid),
            (":kty", &self.kty),
            (":alg", &self.alg),
            (":values", &self.values),
            (":isActive", &self.is_active),
        ]
    }
}

impl TryFrom<&Row<'_>> for SigningKey {
    type Error = rusqlite::Error;
    fn try_from(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(SigningKey {
            kid: row.get("kid")?,
            kty: row.get("kty")?,
            alg: row.get("alg")?,
            values: row.get("values_json")?,
            is_active: row.get("isActive")?,
        })
    }
}

impl GatekeeperStore {
    pub fn all_signing_keys(&self) -> crate::store::DbResult<Vec<SigningKey>> {
        let conn = self.conn().lock();
        let mut stmt = conn.prepare(
            "SELECT kid, kty, alg, values_json, isActive FROM signingKeys ORDER BY isActive DESC, kid",
        )?;
        let rows: rusqlite::Result<Vec<_>> = stmt
            .query_map([], |row| SigningKey::try_from(row))?
            .collect();
        rows
    }

    pub fn active_signing_key(&self) -> crate::store::DbResult<Option<SigningKey>> {
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

    pub fn insert_signing_key(&self, key: &SigningKey) -> crate::store::DbResult<()> {
        // The schema column is `values_json`; the named param is `:values`.
        // Map via a positional ordering in a single execute that uses
        // `as_named_sql_params` to keep the field/value mapping
        // co-located with the domain object.
        self.conn().lock().execute(
            "INSERT INTO signingKeys (kid, kty, alg, values_json, isActive)
             VALUES (:kid, :kty, :alg, :values, :isActive)",
            &key.as_named_sql_params(),
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
