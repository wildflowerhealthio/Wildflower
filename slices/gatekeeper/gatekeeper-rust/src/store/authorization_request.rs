use chrono::{DateTime, Duration, Utc};
use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ToSqlOutput, ValueRef};
use rusqlite::{params, OptionalExtension, Row, ToSql};

use super::types::Json;
use super::GatekeeperStore;

/// Which OAuth grant flow an `AuthorizationRequest` represents. Stored as the
/// wire-level RFC string in the `grantType` column.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GrantType {
    /// RFC 6749 §4.1 authorization-code flow.
    AuthorizationCode,
    /// RFC 8628 device-code flow.
    DeviceCode,
}

impl GrantType {
    pub fn as_str(&self) -> &'static str {
        match self {
            GrantType::AuthorizationCode => "authorization_code",
            GrantType::DeviceCode => "device_code",
        }
    }
    pub fn parse(s: &str) -> Option<GrantType> {
        match s {
            "authorization_code" => Some(GrantType::AuthorizationCode),
            "device_code" => Some(GrantType::DeviceCode),
            _ => None,
        }
    }
}

impl ToSql for GrantType {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(ToSqlOutput::Borrowed(ValueRef::Text(self.as_str().as_bytes())))
    }
}

impl FromSql for GrantType {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        let s = value.as_str()?;
        GrantType::parse(s).ok_or_else(|| FromSqlError::Other(format!("unknown grant_type {s}").into()))
    }
}

/// Current state of an `AuthorizationRequest` as it moves from creation to
/// terminal outcome.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestStatus {
    /// Awaiting user (or pre-approved grant) decision.
    Pending,
    /// User approved; `granted_scopes` is populated.
    Approved,
    /// User denied.
    Denied,
    /// Either timed out or was consumed (device-flow single-use).
    Expired,
}

impl RequestStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            RequestStatus::Pending => "pending",
            RequestStatus::Approved => "approved",
            RequestStatus::Denied => "denied",
            RequestStatus::Expired => "expired",
        }
    }
    pub fn parse(s: &str) -> Option<RequestStatus> {
        match s {
            "pending" => Some(RequestStatus::Pending),
            "approved" => Some(RequestStatus::Approved),
            "denied" => Some(RequestStatus::Denied),
            "expired" => Some(RequestStatus::Expired),
            _ => None,
        }
    }
}

impl ToSql for RequestStatus {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(ToSqlOutput::Borrowed(ValueRef::Text(self.as_str().as_bytes())))
    }
}

impl FromSql for RequestStatus {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        let s = value.as_str()?;
        RequestStatus::parse(s).ok_or_else(|| FromSqlError::Other(format!("unknown status {s}").into()))
    }
}

/// Persisted in-flight OAuth authorization request — used to track both
/// authorization-code and device-code flows from creation through approval,
/// denial, or expiry. The optional fields are populated only for the flow
/// they apply to (e.g. `code_challenge` for auth-code, `user_code` for device).
#[derive(Debug, Clone)]
pub struct AuthorizationRequest {
    pub id: String,
    pub grant_type: GrantType,
    pub client_id: String,
    pub requested_scopes: Json<Vec<String>>,
    pub code_challenge: Option<String>,
    pub code_challenge_method: Option<String>,
    pub redirect_uri: Option<String>,
    pub client_state: Option<String>,
    pub user_code: Option<String>,
    pub pre_approved_scopes: Option<Json<Vec<String>>>,
    pub requested_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub last_polled_at: Option<DateTime<Utc>>,
    pub status: RequestStatus,
    pub granted_scopes: Option<Json<Vec<String>>>,
    pub patient: Option<String>,
}

/// Inputs to start an authorization-code flow request.
pub struct NewCodeFlow {
    pub id: String,
    pub client_id: String,
    pub requested_scopes: Vec<String>,
    pub code_challenge: String,
    pub redirect_uri: String,
    pub client_state: String,
    pub pre_approved_scopes: Option<Vec<String>>,
    pub ttl: Duration,
}

/// Inputs to start a device-code flow request.
pub struct NewDeviceFlow {
    pub id: String,
    pub client_id: String,
    pub requested_scopes: Vec<String>,
    pub user_code: String,
    pub ttl: Duration,
}

impl AuthorizationRequest {
    pub fn new_code_flow(input: NewCodeFlow) -> Self {
        let now = Utc::now();
        AuthorizationRequest {
            id: input.id,
            grant_type: GrantType::AuthorizationCode,
            client_id: input.client_id,
            requested_scopes: Json(input.requested_scopes),
            code_challenge: Some(input.code_challenge),
            code_challenge_method: Some("S256".to_string()),
            redirect_uri: Some(input.redirect_uri),
            client_state: Some(input.client_state),
            user_code: None,
            pre_approved_scopes: input.pre_approved_scopes.map(Json),
            requested_at: now,
            expires_at: now + input.ttl,
            last_polled_at: None,
            status: RequestStatus::Pending,
            granted_scopes: None,
            patient: None,
        }
    }

    pub fn new_device_flow(input: NewDeviceFlow) -> Self {
        let now = Utc::now();
        AuthorizationRequest {
            id: input.id,
            grant_type: GrantType::DeviceCode,
            client_id: input.client_id,
            requested_scopes: Json(input.requested_scopes),
            code_challenge: None,
            code_challenge_method: None,
            redirect_uri: None,
            client_state: None,
            user_code: Some(input.user_code),
            pre_approved_scopes: None,
            requested_at: now,
            expires_at: now + input.ttl,
            last_polled_at: None,
            status: RequestStatus::Pending,
            granted_scopes: None,
            patient: None,
        }
    }

    pub fn as_named_sql_params(&self) -> [(&str, &dyn ToSql); 16] {
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
    ) -> crate::store::DbResult<Option<AuthorizationRequest>> {
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
    ) -> crate::store::DbResult<Option<AuthorizationRequest>> {
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
    ) -> crate::store::DbResult<()> {
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
    ) -> crate::store::DbResult<()> {
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
    pub fn deny_authorization_request(&self, id: &str) -> crate::store::DbResult<()> {
        self.conn().lock().execute(
            "UPDATE authorizationRequests SET status = 'denied' WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    }

    /// Mark `id` expired — used both for genuine timeouts and to enforce the
    /// device-flow single-use rule after a successful token exchange.
    pub fn expire_authorization_request(&self, id: &str) -> crate::store::DbResult<()> {
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
    ) -> crate::store::DbResult<()> {
        self.conn().lock().execute(
            "UPDATE authorizationRequests SET lastPolledAt = ?2 WHERE id = ?1",
            params![id, polled_at],
        )?;
        Ok(())
    }
}
