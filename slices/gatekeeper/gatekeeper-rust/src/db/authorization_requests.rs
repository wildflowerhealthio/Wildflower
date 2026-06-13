use chrono::{DateTime, Utc};
use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ToSqlOutput, ValueRef};
use rusqlite::{params, OptionalExtension, Row, ToSql};

use crate::db_utils::sql_builder::build_insert_sql;
use crate::db_utils::JsonColumn;
use crate::db_utils::{DbResult, GatekeeperStore};
use crate::domain::authorization_request::{AuthorizationRequest, GrantType, RequestStatus};

impl ToSql for GrantType {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(ToSqlOutput::Borrowed(ValueRef::Text(
            <&str>::from(self).as_bytes(),
        )))
    }
}

impl FromSql for GrantType {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        let s = value.as_str()?;
        s.parse::<GrantType>()
            .map_err(|e| FromSqlError::Other(Box::new(e)))
    }
}

impl ToSql for RequestStatus {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(ToSqlOutput::Borrowed(ValueRef::Text(
            <&str>::from(self).as_bytes(),
        )))
    }
}

impl FromSql for RequestStatus {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        let s = value.as_str()?;
        s.parse::<RequestStatus>()
            .map_err(|e| FromSqlError::Other(Box::new(e)))
    }
}

fn make_named_sql_params(request: &AuthorizationRequest) -> [(&str, &dyn ToSql); 16] {
    [
        (":id", &request.id),
        (":grant_type", &request.grant_type),
        (":client_id", &request.client_id),
        (":requested_scopes", &request.requested_scopes),
        (":code_challenge", &request.code_challenge),
        (":code_challenge_method", &request.code_challenge_method),
        (":redirect_uri", &request.redirect_uri),
        (":client_state", &request.client_state),
        (":user_code", &request.user_code),
        (":pre_approved_scopes", &request.pre_approved_scopes),
        (":requested_at", &request.requested_at),
        (":expires_at", &request.expires_at),
        (":last_polled_at", &request.last_polled_at),
        (":status", &request.status),
        (":granted_scopes", &request.granted_scopes),
        (":patient", &request.patient),
    ]
}

impl TryFrom<&Row<'_>> for AuthorizationRequest {
    type Error = rusqlite::Error;
    fn try_from(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(AuthorizationRequest {
            id: row.get("id")?,
            grant_type: row.get("grant_type")?,
            client_id: row.get("client_id")?,
            requested_scopes: row.get("requested_scopes")?,
            code_challenge: row.get("code_challenge")?,
            code_challenge_method: row.get("code_challenge_method")?,
            redirect_uri: row.get("redirect_uri")?,
            client_state: row.get("client_state")?,
            user_code: row.get("user_code")?,
            pre_approved_scopes: row.get("pre_approved_scopes")?,
            requested_at: row.get("requested_at")?,
            expires_at: row.get("expires_at")?,
            last_polled_at: row.get("last_polled_at")?,
            status: row.get("status")?,
            granted_scopes: row.get("granted_scopes")?,
            patient: row.get("patient")?,
        })
    }
}

const ALL_COLS: &str =
    "id, grant_type, client_id, requested_scopes, code_challenge, code_challenge_method, redirect_uri, \
     client_state, user_code, pre_approved_scopes, requested_at, expires_at, last_polled_at, status, \
     granted_scopes, patient";

impl GatekeeperStore {
    /// Load an authorization request by its primary id (the `device_code` for
    /// device-flow, otherwise an internal UUID).
    ///
    /// # Errors
    ///
    /// Returns an error if the select query fails or a returned row cannot be
    /// mapped to an [`AuthorizationRequest`].
    pub fn authorization_request_by_id(&self, id: &str) -> DbResult<Option<AuthorizationRequest>> {
        self.conn()
            .lock()
            .query_row(
                &format!("SELECT {ALL_COLS} FROM authorization_requests WHERE id = ?1"),
                params![id],
                |row| AuthorizationRequest::try_from(row),
            )
            .optional()
    }

    /// Load an authorization request by the human-typed `user_code` that the
    /// device-flow handed to the user.
    ///
    /// Returns *any* row with the code regardless of status — callers that need
    /// to act on a live request (e.g. the consent UI) must use
    /// [`Self::pending_authorization_request_by_user_code`] instead, since
    /// `user_code` is not unique across terminal rows and a stale denied/expired
    /// row could otherwise shadow a fresh pending one.
    ///
    /// # Errors
    ///
    /// Returns an error if the select query fails or a returned row cannot be
    /// mapped to an [`AuthorizationRequest`].
    pub fn authorization_request_by_user_code(
        &self,
        user_code: &str,
    ) -> DbResult<Option<AuthorizationRequest>> {
        self.conn()
            .lock()
            .query_row(
                &format!("SELECT {ALL_COLS} FROM authorization_requests WHERE user_code = ?1"),
                params![user_code],
                |row| AuthorizationRequest::try_from(row),
            )
            .optional()
    }

    /// Load the *pending* authorization request for `user_code`. Filtering on
    /// `status = 'pending'` ensures a stale denied/expired row sharing the same
    /// `user_code` can't shadow a live request and 404 the consent flow.
    ///
    /// # Errors
    ///
    /// Returns an error if the select query fails or a returned row cannot be
    /// mapped to an [`AuthorizationRequest`].
    pub fn pending_authorization_request_by_user_code(
        &self,
        user_code: &str,
    ) -> DbResult<Option<AuthorizationRequest>> {
        self.conn()
            .lock()
            .query_row(
                &format!(
                    "SELECT {ALL_COLS} FROM authorization_requests \
                     WHERE user_code = ?1 AND status = 'pending'"
                ),
                params![user_code],
                |row| AuthorizationRequest::try_from(row),
            )
            .optional()
    }

    /// Persist a freshly-constructed `AuthorizationRequest`.
    ///
    /// # Errors
    ///
    /// Returns an error if the insert fails (for example a unique-constraint
    /// violation on the id).
    pub fn insert_authorization_request(&self, request: &AuthorizationRequest) -> DbResult<()> {
        let params = make_named_sql_params(request);
        self.conn().lock().execute(
            &build_insert_sql("authorization_requests", &params),
            &params,
        )?;
        Ok(())
    }

    /// Mark `id` approved with `granted_scopes` and an optional patient context.
    ///
    /// # Errors
    ///
    /// Returns an error if the update statement fails.
    pub fn approve_authorization_request(
        &self,
        id: &str,
        granted_scopes: &[String],
        patient: Option<&str>,
    ) -> DbResult<()> {
        let granted = JsonColumn(granted_scopes.to_vec());
        self.conn().lock().execute(
            "UPDATE authorization_requests
             SET status = 'approved', granted_scopes = :granted_scopes, patient = :patient
             WHERE id = :id",
            rusqlite::named_params! {
                ":id": id,
                ":granted_scopes": granted,
                ":patient": patient,
            },
        )?;
        Ok(())
    }

    /// Mark `id` denied.
    ///
    /// # Errors
    ///
    /// Returns a `rusqlite::Error` if the update statement fails.
    pub fn deny_authorization_request(&self, id: &str) -> DbResult<()> {
        self.conn().lock().execute(
            "UPDATE authorization_requests SET status = 'denied' WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    }

    /// Atomically claim an `approved` request for single-use redemption,
    /// transitioning `approved` → `expired` only if it is still `approved`, and
    /// return `true` iff this call won the race.
    ///
    /// The `status = 'approved'` guard plus the affected-row check are what make
    /// device-flow redemption single-use (RFC 8628 §3.4) even under concurrent
    /// polls: `SQLite`'s write lock serialises the two `UPDATE`s, so exactly one
    /// sees a row to change (`true`) and any racer sees zero rows (`false`) and
    /// must be rejected before a token is minted. A plain unguarded `UPDATE …
    /// SET status='expired'` (the previous implementation) could not detect that
    /// another poll had already redeemed the request.
    ///
    /// # Errors
    ///
    /// Returns a `rusqlite::Error` if the update statement fails.
    pub fn consume_approved_authorization_request(&self, id: &str) -> DbResult<bool> {
        let affected = self.conn().lock().execute(
            "UPDATE authorization_requests SET status = 'expired' \
             WHERE id = ?1 AND status = 'approved'",
            params![id],
        )?;
        Ok(affected == 1)
    }

    /// Stamp `last_polled_at` so the next device-flow poll can be slow-down
    /// rate-limited.
    ///
    /// # Errors
    ///
    /// Returns a `rusqlite::Error` if the update statement fails.
    pub fn record_device_poll(&self, id: &str, polled_at: DateTime<Utc>) -> DbResult<()> {
        self.conn().lock().execute(
            "UPDATE authorization_requests SET last_polled_at = ?2 WHERE id = ?1",
            params![id, polled_at],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::{arb_opt_timestamp, arb_timestamp, arb_url};
    use crate::db_utils::{JsonColumn, UriColumn};
    use proptest::prelude::*;

    fn arb_scopes() -> impl Strategy<Value = Vec<String>> {
        prop::collection::vec("[a-z][a-z0-9_]{0,15}", 0..5)
    }

    fn arb_status() -> impl Strategy<Value = RequestStatus> {
        prop_oneof![
            Just(RequestStatus::Pending),
            Just(RequestStatus::Approved),
            Just(RequestStatus::Denied),
            Just(RequestStatus::Expired),
        ]
    }

    // Each nullable field is generated independently so every property run
    // mixes present and absent values regardless of `grant_type`, covering the
    // "optional fields both present and absent" case the reviewer asked for.
    prop_compose! {
        fn arb_authorization_request()(
            id in "[a-zA-Z0-9_-]{1,40}",
            grant_type in prop_oneof![
                Just(GrantType::AuthorizationCode),
                Just(GrantType::DeviceCode),
            ],
            client_id in "[a-zA-Z0-9_-]{1,32}",
            requested_scopes in arb_scopes(),
            code_challenge in prop::option::of("[A-Za-z0-9_-]{43}"),
            code_challenge_method in prop::option::of(Just("S256".to_string())),
            redirect_uri in prop::option::of(arb_url()),
            client_state in prop::option::of("[A-Za-z0-9_-]{1,32}"),
            user_code in prop::option::of("[A-Z0-9-]{1,16}"),
            pre_approved_scopes in arb_scopes(),
            requested_at in arb_timestamp(),
            expires_at in arb_timestamp(),
            last_polled_at in arb_opt_timestamp(),
            status in arb_status(),
            granted_scopes in prop::option::of(arb_scopes()),
            patient in prop::option::of("[a-zA-Z0-9-]{1,32}"),
        ) -> AuthorizationRequest {
            AuthorizationRequest {
                id,
                grant_type,
                client_id,
                requested_scopes: JsonColumn(requested_scopes),
                code_challenge,
                code_challenge_method,
                redirect_uri: redirect_uri.map(UriColumn),
                client_state,
                user_code,
                pre_approved_scopes: JsonColumn(pre_approved_scopes),
                requested_at,
                expires_at,
                last_polled_at,
                status,
                granted_scopes: granted_scopes.map(JsonColumn),
                patient,
            }
        }
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(64))]

        #[test]
        fn insert_and_fetch_round_trip(request in arb_authorization_request()) {
            let store = GatekeeperStore::open_in_memory().expect("open in-memory store");
            store
                .insert_authorization_request(&request)
                .expect("insert");
            let fetched = store
                .authorization_request_by_id(&request.id)
                .expect("query")
                .expect("row present");
            prop_assert_eq!(fetched, request);
        }
    }

    fn device_request_with_status(id: &str, status: RequestStatus) -> AuthorizationRequest {
        let now = Utc::now();
        AuthorizationRequest {
            id: id.to_string(),
            grant_type: GrantType::DeviceCode,
            client_id: "device-client".to_string(),
            requested_scopes: JsonColumn(vec!["openid".to_string()]),
            code_challenge: None,
            code_challenge_method: None,
            redirect_uri: None,
            client_state: None,
            user_code: Some("WILD-FLWR".to_string()),
            pre_approved_scopes: JsonColumn(vec![]),
            requested_at: now,
            expires_at: now + chrono::Duration::minutes(5),
            last_polled_at: None,
            status,
            granted_scopes: Some(JsonColumn(vec!["openid".to_string()])),
            patient: None,
        }
    }

    // Single-use enforcement for the device-code grant (RFC 8628 §3.4): the
    // first claim of an approved request wins and transitions it out of
    // `approved`; a second (the racing/duplicate poll) loses. This is the
    // atomicity that stops two concurrent polls both minting tokens.
    #[test]
    fn consume_approved_authorization_request_is_single_use() {
        let store = GatekeeperStore::open_in_memory().expect("open in-memory store");
        store
            .insert_authorization_request(&device_request_with_status(
                "dev-1",
                RequestStatus::Approved,
            ))
            .expect("insert");

        assert!(store
            .consume_approved_authorization_request("dev-1")
            .expect("first claim query"));
        assert!(!store
            .consume_approved_authorization_request("dev-1")
            .expect("second claim query"));

        let after = store
            .authorization_request_by_id("dev-1")
            .expect("query")
            .expect("row present");
        assert_eq!(after.status, RequestStatus::Expired);
    }

    // A request that is not `approved` is never claimable and is left untouched
    // — the guard transitions only `approved` → `expired`.
    #[test]
    fn consume_approved_authorization_request_ignores_non_approved() {
        let store = GatekeeperStore::open_in_memory().expect("open in-memory store");
        store
            .insert_authorization_request(&device_request_with_status(
                "dev-2",
                RequestStatus::Pending,
            ))
            .expect("insert");

        assert!(!store
            .consume_approved_authorization_request("dev-2")
            .expect("pending is not claimable"));

        let after = store
            .authorization_request_by_id("dev-2")
            .expect("query")
            .expect("row present");
        assert_eq!(after.status, RequestStatus::Pending);
    }
}
