use chrono::{DateTime, Duration, Utc};
use strum::{AsRefStr, Display, EnumString};
use url::Url;

use persistence_rust::{JsonColumn, UriColumn};

/// Which OAuth grant flow an `AuthorizationRequest` represents. Stored as the
/// wire-level RFC string in the `grantType` column.
///
/// `strum` derives the `&str` ↔ enum conversions from the `snake_case` variant
/// names — `AuthorizationCode` → `"authorization_code"`, `DeviceCode` →
/// `"device_code"` — matching the RFC 6749 / RFC 8628 `grant_type` values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, EnumString, AsRefStr, Display)]
#[strum(serialize_all = "snake_case")]
pub enum GrantType {
    /// RFC 6749 §4.1 authorization-code flow.
    AuthorizationCode,
    /// RFC 8628 device-code flow.
    DeviceCode,
}

/// Current state of an `AuthorizationRequest` as it moves from creation to
/// terminal outcome.
///
/// `strum` derives the `&str` ↔ enum conversions from the `snake_case` variant
/// names — `Pending` → `"pending"`, and so on — the values stored in the
/// `status` column.
#[derive(Debug, Clone, Copy, PartialEq, Eq, EnumString, AsRefStr, Display)]
#[strum(serialize_all = "snake_case")]
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

/// Persisted in-flight OAuth authorization request — used to track both
/// authorization-code and device-code flows from creation through approval,
/// denial, or expiry. The optional fields are populated only for the flow
/// they apply to (e.g. `code_challenge` for auth-code, `user_code` for device).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthorizationRequest {
    /// Primary key — the device-flow `device_code` for that flow, otherwise an internal UUID.
    pub id: String,
    /// Which OAuth flow this request represents.
    pub grant_type: GrantType,
    /// `client_id` that initiated the request.
    pub client_id: String,
    /// Scopes the client asked for at request time.
    pub requested_scopes: JsonColumn<Vec<String>>,
    /// PKCE S256 challenge (auth-code flow only).
    pub code_challenge: Option<String>,
    /// PKCE method — always `"S256"` when present; `plain` is rejected at the boundary.
    pub code_challenge_method: Option<String>,
    /// Redirect target supplied at `/authorize` (auth-code flow only).
    pub redirect_uri: Option<UriColumn>,
    /// Opaque `state` value the client supplied and expects echoed back in the redirect (auth-code flow only).
    pub client_state: Option<String>,
    /// Human-typed pairing code shown to the user on the device (device-code flow only, RFC 8628).
    pub user_code: Option<String>,
    /// Subset of `requested_scopes` already covered by an existing `Grant`; the
    /// consent UI marks these as pre-approved. Empty means nothing was
    /// pre-approved — there is no distinct "absent" state.
    pub pre_approved_scopes: JsonColumn<Vec<String>>,
    /// When `/authorize` or `/device_authorization` created the request.
    pub requested_at: DateTime<Utc>,
    /// Instant after which the request stops accepting approval.
    pub expires_at: DateTime<Utc>,
    /// Last device-flow `/token` poll, used to enforce the RFC 8628 §3.5 slow-down interval.
    pub last_polled_at: Option<DateTime<Utc>>,
    /// Current lifecycle state — moves from `Pending` to one of `Approved`/`Denied`/`Expired`.
    pub status: RequestStatus,
    /// Scopes the user actually approved; populated once `status == Approved`.
    pub granted_scopes: Option<JsonColumn<Vec<String>>>,
    /// SMART-on-FHIR patient context recorded at approval time, if any.
    pub patient: Option<String>,
    /// Human-chosen name for the requesting device (RFC 8628 extension, device-code flow only);
    /// surfaced to the approver. `None` for auth-code requests and for devices that didn't name
    /// themselves. The settings approver may adjust it at approval time.
    pub device_name: Option<String>,
}

/// Inputs to start an authorization-code flow request.
pub struct StartCodeAuthorizationArgs {
    /// Internal UUID assigned by the handler — becomes the new request's primary key.
    pub id: String,
    /// `client_id` that called `/authorize`.
    pub client_id: String,
    /// Scopes lifted from the wire `scope` parameter (already split on whitespace).
    pub requested_scopes: Vec<String>,
    /// PKCE S256 challenge supplied at `/authorize`.
    pub code_challenge: String,
    /// Already-validated redirect URI to send the user-agent back to after approval.
    pub redirect_uri: Url,
    /// Opaque `state` value to echo back to the client in the redirect.
    pub client_state: String,
    /// Subset of `requested_scopes` already covered by an existing `Grant`;
    /// empty when nothing is pre-approved.
    pub pre_approved_scopes: Vec<String>,
    /// How long the new request stays pending before expiring.
    pub ttl: Duration,
}

/// Inputs to start a device-code flow request.
pub struct StartDeviceAuthorizationArgs {
    /// `device_code` issued to the client — also serves as the request's primary key.
    pub id: String,
    /// `client_id` that called `/device_authorization`.
    pub client_id: String,
    /// Scopes lifted from the wire `scope` parameter (already split on whitespace).
    pub requested_scopes: Vec<String>,
    /// Human-typed pairing code shown to the user on the device.
    pub user_code: String,
    /// Human-chosen name for the device being paired (RFC 8628 extension), or `None`.
    pub device_name: Option<String>,
    /// How long the new request stays pending before expiring.
    pub ttl: Duration,
}

impl AuthorizationRequest {
    #[must_use]
    pub fn new_code_authorization(input: StartCodeAuthorizationArgs) -> Self {
        let now = Utc::now();
        AuthorizationRequest {
            id: input.id,
            grant_type: GrantType::AuthorizationCode,
            client_id: input.client_id,
            requested_scopes: JsonColumn(input.requested_scopes),
            code_challenge: Some(input.code_challenge),
            code_challenge_method: Some("S256".to_string()),
            redirect_uri: Some(UriColumn(input.redirect_uri)),
            client_state: Some(input.client_state),
            user_code: None,
            pre_approved_scopes: JsonColumn(input.pre_approved_scopes),
            requested_at: now,
            expires_at: now + input.ttl,
            last_polled_at: None,
            status: RequestStatus::Pending,
            granted_scopes: None,
            patient: None,
            device_name: None,
        }
    }

    #[must_use]
    pub fn new_device_authorization(input: StartDeviceAuthorizationArgs) -> Self {
        let now = Utc::now();
        AuthorizationRequest {
            id: input.id,
            grant_type: GrantType::DeviceCode,
            client_id: input.client_id,
            requested_scopes: JsonColumn(input.requested_scopes),
            code_challenge: None,
            code_challenge_method: None,
            redirect_uri: None,
            client_state: None,
            user_code: Some(input.user_code),
            pre_approved_scopes: JsonColumn(Vec::new()),
            requested_at: now,
            expires_at: now + input.ttl,
            last_polled_at: None,
            status: RequestStatus::Pending,
            granted_scopes: None,
            patient: None,
            device_name: input.device_name,
        }
    }
}
