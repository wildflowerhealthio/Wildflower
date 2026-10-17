use chrono::{DateTime, Duration, Utc};
use diesel::deserialize::FromSqlRow;
use diesel::expression::AsExpression;
use strum::{AsRefStr, Display, EnumString};
use url::Url;

use crate::domain::launch_context::LaunchContext;

/// Minimum polling interval the device-code flow enforces (RFC 8628 §3.5) —
/// advertised as `interval` in the device-authorization response and enforced
/// against `last_polled_at` with `slow_down` at `/token`.
pub const DEVICE_CODE_POLL_INTERVAL: Duration = Duration::seconds(5);

/// Which flow an `AuthorizationRequest` belongs to: one of the two OAuth grant
/// flows, or a browser pairing, which is no OAuth grant. Stored in the
/// `grant_type` column.
///
/// `strum` derives the `&str` ↔ enum conversions from the `snake_case` variant
/// names — `AuthorizationCode` → `"authorization_code"`, `DeviceCode` →
/// `"device_code"`, matching the RFC 6749 / RFC 8628 `grant_type` values, and
/// `BrowserPairing` → `"browser_pairing"`.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, EnumString, AsRefStr, Display, AsExpression, FromSqlRow,
)]
#[strum(serialize_all = "snake_case")]
#[diesel(sql_type = diesel::sql_types::Text)]
pub enum GrantType {
    /// RFC 6749 §4.1 authorization-code flow.
    AuthorizationCode,
    /// RFC 8628 device-code flow.
    DeviceCode,
    /// A browser asking the Owner for a browser session at `/oauth/pair`. Not
    /// an OAuth grant: no client redeems it at `/oauth/token`, and it records
    /// no grant, so no `grants` row carries it. Its approval ends in an
    /// approved browser session.
    BrowserPairing,
}

/// Current state of an `AuthorizationRequest` as it moves from creation to
/// terminal outcome.
///
/// `strum` derives the `&str` ↔ enum conversions from the `snake_case` variant
/// names — `Pending` → `"pending"`, and so on — the values stored in the
/// `status` column.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, EnumString, AsRefStr, Display, AsExpression, FromSqlRow,
)]
#[strum(serialize_all = "snake_case")]
#[diesel(sql_type = diesel::sql_types::Text)]
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

/// Persisted in-flight authorization request — used to track the
/// authorization-code and device-code flows, and browser pairings, from
/// creation through approval, denial, or expiry. The optional fields are
/// populated only for the flow they apply to (e.g. `code_challenge` for
/// auth-code, `user_code` for device and pairing).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthorizationRequest {
    /// Primary key — the device-flow `device_code` for that flow, a browser
    /// pairing's pairing code for a pairing, otherwise an internal UUID.
    pub id: String,
    /// Which flow this request belongs to.
    pub grant_type: GrantType,
    /// `client_id` that initiated the request.
    pub client_id: String,
    /// Scopes the client asked for at request time.
    pub requested_scopes: Vec<String>,
    /// PKCE S256 challenge (auth-code flow only).
    pub code_challenge: Option<String>,
    /// PKCE method — always `"S256"` when present; `plain` is rejected at the boundary.
    pub code_challenge_method: Option<String>,
    /// Redirect target supplied at `/authorize` (auth-code flow only).
    pub redirect_uri: Option<Url>,
    /// Opaque `state` value the client supplied and expects echoed back in the redirect (auth-code flow only).
    pub client_state: Option<String>,
    /// Human-typed pairing code shown to the user on the device (device-code
    /// flow, RFC 8628) or on the pairing page (browser pairing).
    pub user_code: Option<String>,
    /// Subset of `requested_scopes` already covered by an existing `Grant`; the
    /// consent UI marks these as pre-approved. Empty means nothing was
    /// pre-approved — there is no distinct "absent" state.
    pub pre_approved_scopes: Vec<String>,
    /// When `/authorize` or `/device_authorization` created the request.
    pub requested_at: DateTime<Utc>,
    /// Instant after which the request stops accepting approval.
    pub expires_at: DateTime<Utc>,
    /// Last device-flow `/token` poll, or pairing-page poll, used to enforce
    /// the RFC 8628 §3.5 slow-down interval.
    pub last_polled_at: Option<DateTime<Utc>>,
    /// Current lifecycle state — moves from `Pending` to one of `Approved`/`Denied`/`Expired`.
    pub status: RequestStatus,
    /// Scopes the user actually approved; populated once `status == Approved`.
    pub granted_scopes: Option<Vec<String>>,
    /// SMART-on-FHIR patient context recorded at approval time, if any.
    pub patient: Option<String>,
    /// Human-chosen name for the requesting device (RFC 8628 extension, device-code flow only);
    /// surfaced to the approver. `None` for auth-code requests and for devices that didn't name
    /// themselves. A browser pairing's browser name. The approver may adjust it
    /// at approval time.
    pub device_name: Option<String>,
    /// The SMART App Launch `launch` value this request consumed at
    /// `/authorize` (auth-code flow only). `None` for a plain OAuth request.
    pub launch: Option<String>,
    /// The patient the consumed launch context binds, if any. When set, an
    /// approval must name this patient (see [`Self::admits_patient`]).
    pub launch_bound_patient: Option<String>,
    /// Whether the request can be decided in the browser that made it: that
    /// browser carried a browser session that can decide consents, so it is
    /// sent to the consent card itself (auth-code flow only; `false` for a
    /// device request).
    pub decidable_in_requesting_browser: bool,
    /// The browser session the request was made in (auth-code flow only),
    /// which the code it earns is issued under; `None` when the browser had
    /// none, and for a device request.
    pub sid: Option<String>,
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
    /// The launch context `/authorize` consumed for this request, or `None` for
    /// a plain OAuth request.
    pub launch_context: Option<LaunchContext>,
    /// Whether the request can be decided in the browser calling
    /// `/authorize`: it carries a browser session that can decide consents.
    pub decidable_in_requesting_browser: bool,
    /// The browser session the browser calling `/authorize` holds, if any.
    pub sid: Option<String>,
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

/// Inputs to start a browser pairing request.
pub struct StartBrowserPairingArgs {
    /// The pairing code the pairing page polls with — a secret only that page
    /// holds, and the request's primary key.
    pub id: String,
    /// The client every browser session's token is issued to.
    pub client_id: String,
    /// The scopes the Owner's ticks start from.
    pub requested_scopes: Vec<String>,
    /// The code the pairing page shows, which the Owner confirms at the device
    /// page.
    pub user_code: String,
    /// The name the browser goes by on the Owner's card.
    pub browser_name: String,
    /// How long the new request stays pending before expiring.
    pub ttl: Duration,
}

/// The name a device grant is keyed on: the device name recorded on the
/// request, or the client's own name when it has none. The approval records the
/// grant under it and the token poll looks the grant up by it, so both go
/// through here.
pub(crate) fn device_grant_name<'a>(
    request_device_name: Option<&'a str>,
    client_name: &'a str,
) -> &'a str {
    request_device_name.unwrap_or(client_name)
}

impl AuthorizationRequest {
    /// Whether an approval may bind `patient` to this request: any patient (or
    /// none) when its launch bound no patient, otherwise exactly the launch's.
    #[must_use]
    pub fn admits_patient(&self, patient: Option<&str>) -> bool {
        match self.launch_bound_patient.as_deref() {
            None => true,
            Some(launch_bound_patient) => patient == Some(launch_bound_patient),
        }
    }

    #[must_use]
    pub fn new_code_authorization(input: StartCodeAuthorizationArgs) -> Self {
        let now = Utc::now();
        let (launch, launch_bound_patient) = input.launch_context.map_or((None, None), |context| {
            let launch_bound_patient = context.patient().map(str::to_owned);
            (Some(context.nonce), launch_bound_patient)
        });
        AuthorizationRequest {
            id: input.id,
            grant_type: GrantType::AuthorizationCode,
            client_id: input.client_id,
            requested_scopes: input.requested_scopes,
            code_challenge: Some(input.code_challenge),
            code_challenge_method: Some("S256".to_string()),
            redirect_uri: Some(input.redirect_uri),
            client_state: Some(input.client_state),
            user_code: None,
            pre_approved_scopes: input.pre_approved_scopes,
            requested_at: now,
            expires_at: now + input.ttl,
            last_polled_at: None,
            status: RequestStatus::Pending,
            granted_scopes: None,
            patient: None,
            device_name: None,
            launch,
            launch_bound_patient,
            decidable_in_requesting_browser: input.decidable_in_requesting_browser,
            sid: input.sid,
        }
    }

    #[must_use]
    pub fn new_device_authorization(input: StartDeviceAuthorizationArgs) -> Self {
        let now = Utc::now();
        AuthorizationRequest {
            id: input.id,
            grant_type: GrantType::DeviceCode,
            client_id: input.client_id,
            requested_scopes: input.requested_scopes,
            code_challenge: None,
            code_challenge_method: None,
            redirect_uri: None,
            client_state: None,
            user_code: Some(input.user_code),
            pre_approved_scopes: Vec::new(),
            requested_at: now,
            expires_at: now + input.ttl,
            last_polled_at: None,
            status: RequestStatus::Pending,
            granted_scopes: None,
            patient: None,
            device_name: input.device_name,
            launch: None,
            launch_bound_patient: None,
            decidable_in_requesting_browser: false,
            sid: None,
        }
    }

    /// A pending browser pairing request. Its name is kept in `device_name`,
    /// the column the device page reads a requester's name from.
    #[must_use]
    pub fn new_browser_pairing(input: StartBrowserPairingArgs) -> Self {
        let now = Utc::now();
        AuthorizationRequest {
            id: input.id,
            grant_type: GrantType::BrowserPairing,
            client_id: input.client_id,
            requested_scopes: input.requested_scopes,
            code_challenge: None,
            code_challenge_method: None,
            redirect_uri: None,
            client_state: None,
            user_code: Some(input.user_code),
            pre_approved_scopes: Vec::new(),
            requested_at: now,
            expires_at: now + input.ttl,
            last_polled_at: None,
            status: RequestStatus::Pending,
            granted_scopes: None,
            patient: None,
            device_name: Some(input.browser_name),
            launch: None,
            launch_bound_patient: None,
            decidable_in_requesting_browser: false,
            sid: None,
        }
    }
}
