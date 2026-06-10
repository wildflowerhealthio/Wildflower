use chrono::{DateTime, Utc};
use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ToSqlOutput, ValueRef};
use rusqlite::{params, OptionalExtension, Row, ToSql};

use super::GatekeeperStore;
use crate::domain::authorization_request::{AuthorizationRequest, GrantType, RequestStatus};
use crate::json::Json;

impl ToSql for GrantType {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(ToSqlOutput::Borrowed(ValueRef::Text(
            self.as_str().as_bytes(),
        )))
    }
}

impl FromSql for GrantType {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        let s = value.as_str()?;
        GrantType::parse(s)
            .ok_or_else(|| FromSqlError::Other(format!("unknown grant_type {s}").into()))
    }
}

impl ToSql for RequestStatus {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(ToSqlOutput::Borrowed(ValueRef::Text(
            self.as_str().as_bytes(),
        )))
    }
}

impl FromSql for RequestStatus {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        let s = value.as_str()?;
        RequestStatus::parse(s)
            .ok_or_else(|| FromSqlError::Other(format!("unknown status {s}").into()))
    }
}

impl AuthorizationRequest {
    pub(in crate::db) fn as_named_sql_params(&self) -> [(&str, &dyn ToSql); 16] {
        [
            (":id", &self.id),
            (":grantType", &self.grant_type),
            (":clientId", &self.client_id),
            (":requestedScopes", &self.requested_scopes),
            (":codeChallenge", &self.code_challenge),
            (":codeChallengeMethod", &self.code_challenge_method),
            (":redirectUri", &self.redirect_uri),
            (":clientState", &self.client_state),
            (":userCode", &self.user_code),
            (":preApprovedScopes", &self.pre_approved_scopes),
            (":requestedAt", &self.requested_at),
            (":expiresAt", &self.expires_at),
            (":lastPolledAt", &self.last_polled_at),
            (":status", &self.status),
            (":grantedScopes", &self.granted_scopes),
            (":patient", &self.patient),
        ]
    }
}

impl TryFrom<&Row<'_>> for AuthorizationRequest {
    type Error = rusqlite::Error;
    fn try_from(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(AuthorizationRequest {
            id: row.get("id")?,
            grant_type: row.get("grantType")?,
            client_id: row.get("clientId")?,
            requested_scopes: row.get("requestedScopes")?,
            code_challenge: row.get("codeChallenge")?,
            code_challenge_method: row.get("codeChallengeMethod")?,
            redirect_uri: row.get("redirectUri")?,
            client_state: row.get("clientState")?,
            user_code: row.get("userCode")?,
            pre_approved_scopes: row.get("preApprovedScopes")?,
            requested_at: row.get("requestedAt")?,
            expires_at: row.get("expiresAt")?,
            last_polled_at: row.get("lastPolledAt")?,
            status: row.get("status")?,
            granted_scopes: row.get("grantedScopes")?,
            patient: row.get("patient")?,
        })
    }
}

const ALL_COLS: &str =
    "id, grantType, clientId, requestedScopes, codeChallenge, codeChallengeMethod, redirectUri, \
     clientState, userCode, preApprovedScopes, requestedAt, expiresAt, lastPolledAt, status, \
     grantedScopes, patient";

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
                &format!("SELECT {ALL_COLS} FROM authorizationRequests WHERE id = ?1"),
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
                &format!("SELECT {ALL_COLS} FROM authorizationRequests WHERE userCode = ?1"),
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
        self.conn().lock().execute(
            "INSERT INTO authorizationRequests
             (id, grantType, clientId, requestedScopes, codeChallenge, codeChallengeMethod, redirectUri,
              clientState, userCode, preApprovedScopes, requestedAt, expiresAt, lastPolledAt, status,
              grantedScopes, patient)
             VALUES (:id, :grantType, :clientId, :requestedScopes, :codeChallenge, :codeChallengeMethod,
                     :redirectUri, :clientState, :userCode, :preApprovedScopes, :requestedAt, :expiresAt,
                     :lastPolledAt, :status, :grantedScopes, :patient)",
            &request.as_named_sql_params(),
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
        let granted = Json(granted_scopes.to_vec());
        self.conn().lock().execute(
            "UPDATE authorizationRequests
             SET status = 'approved', grantedScopes = ?2, patient = ?3
             WHERE id = ?1",
            params![id, granted, patient],
        )?;
        Ok(())
    }

    /// Mark `id` denied.
    pub fn deny_authorization_request(&self, id: &str) -> crate::db::DbResult<()> {
        self.conn().lock().execute(
            "UPDATE authorizationRequests SET status = 'denied' WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    }

    /// Mark `id` expired — used both for genuine timeouts and to enforce the
    /// device-flow single-use rule after a successful token exchange.
    pub fn expire_authorization_request(&self, id: &str) -> crate::db::DbResult<()> {
        self.conn().lock().execute(
            "UPDATE authorizationRequests SET status = 'expired' WHERE id = ?1",
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
            "UPDATE authorizationRequests SET lastPolledAt = ?2 WHERE id = ?1",
            params![id, polled_at],
        )?;
        Ok(())
    }
}
