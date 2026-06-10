use chrono::{DateTime, Duration, Utc};

use crate::json::Json;

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
}
