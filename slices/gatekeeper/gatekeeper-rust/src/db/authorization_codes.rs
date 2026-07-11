//! `authorization_codes` queries — issue, look up, and atomically redeem the
//! single-use codes ([`AuthorizationCode`]) minted at `/authorize`.

use diesel::prelude::*;

use crate::db::schema::authorization_codes;
use crate::db::GatekeeperStore;
use crate::domain::authorization_code::AuthorizationCode;
use crate::domain::error::GatekeeperError;

impl GatekeeperStore {
    /// Atomically read-and-delete the authorization code so a `/token`
    /// redemption either gets the row exactly once or sees `None`. Wins the
    /// RFC 6749 §10.5 single-use race against any concurrent redeemer of the
    /// same code — `DELETE … RETURNING` runs under `SQLite`'s write lock, so
    /// only one caller's `Ok(Some)` lands and any racer sees `Ok(None)`.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Backend`] if the delete-returning query fails or a
    /// returned row cannot be mapped to an [`AuthorizationCode`].
    pub fn redeem_authorization_code(
        &self,
        code: &str,
    ) -> Result<Option<AuthorizationCode>, GatekeeperError> {
        diesel::delete(authorization_codes::table.find(code))
            .returning(AuthorizationCode::as_returning())
            .get_result(&mut self.conn()?)
            .optional()
            .map_err(|e| GatekeeperError::backend("redeem_authorization_code failed", e))
    }

    /// Look up the code that was issued for a given `request_id`, used by the
    /// Owner UI's polling endpoint to build the final redirect URL.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Backend`] if the select query fails or a returned
    /// row cannot be mapped to an [`AuthorizationCode`].
    pub fn authorization_code_by_request_id(
        &self,
        request_id: &str,
    ) -> Result<Option<AuthorizationCode>, GatekeeperError> {
        authorization_codes::table
            .filter(authorization_codes::request_id.eq(request_id))
            .select(AuthorizationCode::as_select())
            .first(&mut self.conn()?)
            .optional()
            .map_err(|e| GatekeeperError::backend("authorization_code_by_request_id failed", e))
    }

    /// Persist a freshly-minted authorization code.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Backend`] if the insert fails (for example a
    /// unique-constraint violation on the code).
    pub fn issue_authorization_code(
        &self,
        code: &AuthorizationCode,
    ) -> Result<(), GatekeeperError> {
        diesel::insert_into(authorization_codes::table)
            .values(code.clone())
            .execute(&mut self.conn()?)
            .map_err(|e| GatekeeperError::backend("issue_authorization_code failed", e))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::{arb_timestamp, arb_url};
    use proptest::prelude::*;

    fn arb_authorization_code() -> impl Strategy<Value = AuthorizationCode> {
        (
            "[a-zA-Z0-9_-]{1,40}",
            "[a-zA-Z0-9_-]{1,32}",
            "[a-zA-Z0-9_-]{1,32}",
            arb_url(),
            "[A-Za-z0-9_-]{43}",
            prop::collection::vec("[a-z][a-z0-9_]{0,15}", 0..5),
            prop::option::of("[a-zA-Z0-9-]{1,32}"),
            arb_timestamp(),
            arb_timestamp(),
        )
            .prop_map(
                |(
                    code,
                    request_id,
                    client_id,
                    redirect_uri,
                    code_challenge,
                    granted_scopes,
                    patient,
                    issued_at,
                    expires_at,
                )| AuthorizationCode {
                    code,
                    request_id,
                    client_id,
                    redirect_uri,
                    code_challenge,
                    granted_scopes,
                    patient,
                    issued_at,
                    expires_at,
                },
            )
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(48))]

        #[test]
        fn issue_and_fetch_round_trip(code in arb_authorization_code()) {
            let store = GatekeeperStore::open_in_memory().expect("open in-memory store");
            store.issue_authorization_code(&code).expect("issue");
            let fetched = store
                .authorization_code_by_request_id(&code.request_id)
                .expect("query")
                .expect("row present");
            prop_assert_eq!(fetched, code);
        }
    }

    /// Redemption is destructive and single-winner: the first call returns the
    /// row, the second sees `None` (RFC 6749 §10.5).
    #[test]
    fn redeem_returns_the_row_exactly_once() {
        let store = GatekeeperStore::open_in_memory().expect("open in-memory store");
        let now = chrono::Utc::now();
        let code = AuthorizationCode {
            code: "the-code".to_string(),
            request_id: "req-1".to_string(),
            client_id: "client-a".to_string(),
            redirect_uri: url::Url::parse("https://example.com/cb").expect("url"),
            code_challenge: "c".repeat(43),
            granted_scopes: vec!["read".to_string()],
            patient: None,
            issued_at: now,
            expires_at: now + chrono::Duration::seconds(60),
        };
        store.issue_authorization_code(&code).expect("issue");
        let first = store
            .redeem_authorization_code("the-code")
            .expect("redeem")
            .expect("first redemption wins");
        assert_eq!(first, code);
        assert!(
            store
                .redeem_authorization_code("the-code")
                .expect("redeem again")
                .is_none(),
            "second redemption must lose",
        );
    }
}
