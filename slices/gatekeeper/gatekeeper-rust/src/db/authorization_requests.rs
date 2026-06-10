use chrono::{DateTime, Utc};
use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ToSqlOutput, ValueRef};
use rusqlite::{params, OptionalExtension, Row, ToSql};

use super::GatekeeperStore;
use crate::domain::authorization_request::{AuthorizationRequest, GrantType, RequestStatus};
use crate::db_utils::sql_builder::build_insert_sql;
use crate::db_utils::JsonColumn;

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
            .map_err(|_| FromSqlError::Other(format!("unknown grant_type {s}").into()))
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
            .map_err(|_| FromSqlError::Other(format!("unknown status {s}").into()))
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
    pub fn authorization_request_by_id(
        &self,
        id: &str,
    ) -> crate::db::DbResult<Option<AuthorizationRequest>> {
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
    pub fn authorization_request_by_user_code(
        &self,
        user_code: &str,
    ) -> crate::db::DbResult<Option<AuthorizationRequest>> {
        self.conn()
            .lock()
            .query_row(
                &format!("SELECT {ALL_COLS} FROM authorization_requests WHERE user_code = ?1"),
                params![user_code],
                |row| AuthorizationRequest::try_from(row),
            )
            .optional()
    }

    /// Persist a freshly-constructed `AuthorizationRequest`.
    pub fn insert_authorization_request(
        &self,
        request: &AuthorizationRequest,
    ) -> crate::db::DbResult<()> {
        let params = make_named_sql_params(request);
        self.conn().lock().execute(
            &build_insert_sql("authorization_requests", &params),
            &params,
        )?;
        Ok(())
    }

    /// Mark `id` approved with `granted_scopes` and an optional patient context.
    pub fn approve_authorization_request(
        &self,
        id: &str,
        granted_scopes: &[String],
        patient: Option<&str>,
    ) -> crate::db::DbResult<()> {
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
    pub fn deny_authorization_request(&self, id: &str) -> crate::db::DbResult<()> {
        self.conn().lock().execute(
            "UPDATE authorization_requests SET status = 'denied' WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    }

    /// Mark `id` expired — used both for genuine timeouts and to enforce the
    /// device-flow single-use rule after a successful token exchange.
    pub fn expire_authorization_request(&self, id: &str) -> crate::db::DbResult<()> {
        self.conn().lock().execute(
            "UPDATE authorization_requests SET status = 'expired' WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    }

    /// Stamp `last_polled_at` so the next device-flow poll can be slow-down
    /// rate-limited.
    pub fn record_device_poll(
        &self,
        id: &str,
        polled_at: DateTime<Utc>,
    ) -> crate::db::DbResult<()> {
        self.conn().lock().execute(
            "UPDATE authorization_requests SET last_polled_at = ?2 WHERE id = ?1",
            params![id, polled_at],
        )?;
        Ok(())
    }
}
