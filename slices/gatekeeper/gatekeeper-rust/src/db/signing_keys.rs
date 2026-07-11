//! `signing_keys` queries — the RSA keys backing JWS signatures and the JWKS
//! endpoint, loaded/stored as [`SigningKey`].

use diesel::prelude::*;

use crate::db::schema::signing_keys;
use crate::db::GatekeeperStore;
use crate::domain::error::GatekeeperError;
use crate::domain::signing_key::SigningKey;

impl GatekeeperStore {
    /// Load every signing key, active keys first then by `kid`.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Backend`] if the select query fails or any returned
    /// row cannot be mapped to a [`SigningKey`].
    pub fn all_signing_keys(&self) -> Result<Vec<SigningKey>, GatekeeperError> {
        signing_keys::table
            .order((signing_keys::is_active.desc(), signing_keys::kid))
            .select(SigningKey::as_select())
            .load(&mut self.conn()?)
            .map_err(|e| GatekeeperError::backend("all_signing_keys failed", e))
    }

    /// Load the active signing key, if one exists.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Backend`] if the select query fails or a returned
    /// row cannot be mapped to a [`SigningKey`].
    pub fn active_signing_key(&self) -> Result<Option<SigningKey>, GatekeeperError> {
        signing_keys::table
            .filter(signing_keys::is_active.eq(true))
            .select(SigningKey::as_select())
            .first(&mut self.conn()?)
            .optional()
            .map_err(|e| GatekeeperError::backend("active_signing_key failed", e))
    }

    /// Whether an active signing key exists, without loading its (private) key
    /// material — a cheap presence probe for callers that only need to know a
    /// token *can* be minted (the mint path loads the key itself).
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Backend`] if the query fails.
    pub fn has_active_signing_key(&self) -> Result<bool, GatekeeperError> {
        diesel::select(diesel::dsl::exists(
            signing_keys::table.filter(signing_keys::is_active.eq(true)),
        ))
        .get_result(&mut self.conn()?)
        .map_err(|e| GatekeeperError::backend("has_active_signing_key failed", e))
    }

    /// Persist a signing key.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Backend`] if the insert fails (for example a
    /// unique-constraint violation on the `kid`).
    pub fn insert_signing_key(&self, key: &SigningKey) -> Result<(), GatekeeperError> {
        diesel::insert_into(signing_keys::table)
            .values(key.clone())
            .execute(&mut self.conn()?)
            .map_err(|e| GatekeeperError::backend("insert_signing_key failed", e))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::signing_key::SigningKeyValues;
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
