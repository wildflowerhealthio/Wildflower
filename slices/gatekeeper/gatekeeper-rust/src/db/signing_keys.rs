use rusqlite::{params, OptionalExtension, Row, ToSql};

use crate::db_utils::sql_builder::build_insert_sql;
use crate::db_utils::JsonColumn;
use crate::db_utils::{DbResult, GatekeeperStore};
use crate::domain::signing_key::{SigningKey, SigningKeyValues};

impl TryFrom<&Row<'_>> for SigningKey {
    type Error = rusqlite::Error;
    fn try_from(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(SigningKey {
            kid: row.get("kid")?,
            kty: row.get("kty")?,
            alg: row.get("alg")?,
            values: row
                .get::<_, JsonColumn<SigningKeyValues>>("values_json")?
                .into_inner(),
            is_active: row.get("is_active")?,
        })
    }
}

/// `values` isn't stored as a `JsonColumn` field on `SigningKey`, so the JSON
/// wrapper is a temporary the caller must own — hence the `values_json`
/// parameter binds to a `&JsonColumn` local in `insert_signing_key`.
fn make_named_sql_params<'a>(
    key: &'a SigningKey,
    values_json: &'a JsonColumn<&'a SigningKeyValues>,
) -> [(&'a str, &'a dyn ToSql); 5] {
    [
        (":kid", &key.kid),
        (":kty", &key.kty),
        (":alg", &key.alg),
        (":values_json", values_json),
        (":is_active", &key.is_active),
    ]
}

impl GatekeeperStore {
    pub fn all_signing_keys(&self) -> DbResult<Vec<SigningKey>> {
        let conn = self.conn().lock();
        let mut stmt = conn.prepare(
            "SELECT kid, kty, alg, values_json, is_active FROM signing_keys ORDER BY is_active DESC, kid",
        )?;
        let rows: rusqlite::Result<Vec<_>> = stmt
            .query_map([], |row| SigningKey::try_from(row))?
            .collect();
        rows
    }

    pub fn active_signing_key(&self) -> DbResult<Option<SigningKey>> {
        self.conn()
            .lock()
            .query_row(
                "SELECT kid, kty, alg, values_json, is_active FROM signing_keys WHERE is_active = 1 LIMIT 1",
                params![],
                |row| SigningKey::try_from(row),
            )
            .optional()
    }

    pub fn insert_signing_key(&self, key: &SigningKey) -> DbResult<()> {
        let values_json = JsonColumn(&key.values);
        let params = make_named_sql_params(key, &values_json);
        self.conn()
            .lock()
            .execute(&build_insert_sql("signing_keys", &params), &params)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    /// The db layer treats `SigningKeyValues` as opaque JSON, so the
    /// round-trip test uses arbitrary base64url-shaped components rather than
    /// real RSA material.
    fn arb_signing_key() -> impl Strategy<Value = SigningKey> {
        let b64 = "[A-Za-z0-9_-]{1,64}";
        ("[a-zA-Z0-9-]{1,40}", b64, b64, b64, b64, b64, any::<bool>()).prop_map(
            |(kid, n, d, e, p, q, is_active)| SigningKey {
                kid,
                kty: "RSA".to_string(),
                alg: "RS256".to_string(),
                values: SigningKeyValues { n, d, e, p, q },
                is_active,
            },
        )
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(48))]

        #[test]
        fn insert_and_fetch_round_trip(key in arb_signing_key()) {
            let store = GatekeeperStore::open_in_memory().expect("open in-memory store");
            store.insert_signing_key(&key).expect("insert");

            // A freshly-opened store holds exactly this one key.
            let all = store.all_signing_keys().expect("all");
            prop_assert_eq!(all, vec![key.clone()]);

            // `active_signing_key` mirrors the `is_active` flag.
            let active = store.active_signing_key().expect("active");
            let expected_active = if key.is_active { Some(key) } else { None };
            prop_assert_eq!(active, expected_active);
        }
    }
}
