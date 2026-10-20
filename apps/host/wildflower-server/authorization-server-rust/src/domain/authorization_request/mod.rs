//! [`AuthorizationRequest`] — a request the Owner decides, from the moment it
//! starts to its decision and, for the two that start a session, the single
//! claim that redeems the decision. Three kinds share one lifecycle: the two
//! OAuth grant flows (RFC 6749 §4.1 authorization code, RFC 8628 device code)
//! and a browser pairing, which is no OAuth grant.
//!
//! The lifecycle is the entity's own: every change is a method that reads the
//! request as loaded, takes `now`, and answers with a [`RequestTransition`] (the
//! changed request and the [`RequestPhase`] it was read in) or a
//! [`TransitionRefused`]. The store writes a transition back with one guarded
//! replace, so **a transition lands only if the row is still in the phase it
//! was read in**: of two decisions on one request the first wins, and a Cancel
//! racing a Continue on the limited page lands only if the Continue didn't.
//! Approvals never fight poll stamps: a stamp leaves the phase as it was, so an
//! approval read before it still lands, and a stamp read before an approval no
//! longer does.
//!
//! Expiry is derived from `expires_at` ([`AuthorizationRequest::is_expired_at`]),
//! never stored as a status.

pub(crate) mod code;

use chrono::{DateTime, Duration, Utc};
use diesel::deserialize::FromSqlRow;
use diesel::expression::AsExpression;
use strum::{AsRefStr, Display, EnumString};
use url::Url;

/// Minimum polling interval the device-code flow enforces (RFC 8628 §3.5) —
/// advertised as `interval` in the device-authorization response and enforced
/// against a device's or pairing's last poll with `slow_down`.
pub const DEVICE_CODE_POLL_INTERVAL: Duration = Duration::seconds(5);

/// The kind of a request as stored, in the `grant_type` column: one of the two
/// OAuth grant flows, or a browser pairing, which is no OAuth grant. Derived
/// from the request's [`RequestKind`].
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
    /// A browser asking the Owner for a browser session at `/oauth/pair`.
    BrowserPairing,
}

/// Where a request stands, stored in the `status` column.
///
/// `strum` derives the `&str` ↔ enum conversions from the `snake_case` variant
/// names — `Pending` → `"pending"`, and so on.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, EnumString, AsRefStr, Display, AsExpression, FromSqlRow,
)]
#[strum(serialize_all = "snake_case")]
#[diesel(sql_type = diesel::sql_types::Text)]
pub enum RequestStatus {
    /// Awaiting the Owner's decision (until it expires).
    Pending,
    /// The Owner approved it: it carries its [`Approval`].
    Approved,
    /// The Owner, or the browser that made it, declined it.
    Denied,
    /// An approved device request or browser pairing whose poll redeemed the
    /// approval, once (RFC 8628 §3.4 single use). It keeps its [`Approval`].
    Claimed,
}

/// What the Owner approved: the scopes granted and the SMART-on-FHIR patient
/// context bound, if any.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Approval {
    pub granted_scopes: Vec<String>,
    pub patient: Option<String>,
}

/// What a request carries for its kind.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RequestKind {
    /// An RFC 6749 §4.1.1 authorization request, parked by `/oauth/authorize`.
    AuthorizationCode(CodeRequest),
    /// An RFC 8628 §3.1 device authorization request.
    DeviceCode(DeviceRequest),
    /// A browser pairing, started by the pairing page.
    BrowserPairing(PairingRequest),
}

/// What an authorization-code request carries beyond the common core.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodeRequest {
    /// The redirect the client presented; its code or error goes back there.
    pub redirect_uri: Url,
    /// The PKCE S256 challenge (RFC 7636); `plain` is refused at the
    /// boundary, so the method is always S256.
    pub code_challenge: String,
    /// The `state` the client sent, which its callback carries back.
    pub client_state: String,
    /// The browser session the request was made in, which the code it earns
    /// is issued under. `/oauth/authorize` sends a browser without one to
    /// pairing first.
    pub sid: String,
    /// The SMART App Launch `launch` value the request consumed, or `None`
    /// for a plain OAuth request.
    pub launch: Option<String>,
    /// The patient the consumed launch binds, if any. An approval must name
    /// this patient ([`CodeRequest::admits_patient`]).
    pub launch_bound_patient: Option<String>,
    /// The requested scopes a standing grant already covered when it parked;
    /// the consent card shows them ticked.
    pub pre_approved_scopes: Vec<String>,
    /// Whether the request can be decided in the browser that made it: that
    /// browser's session can decide consents and holds the request's approval
    /// scopes, so it shows the consent card itself. Raising the request for
    /// the Owner clears it.
    pub decidable_in_requesting_browser: bool,
    /// Whether the browser that made the request has gone on although its
    /// browser session holds less than the request asks for. `false` while
    /// the request waits on that browser's limited page: the Owner isn't asked
    /// about it and nothing decides it. `true` for a request whose session
    /// holds all it asks for, and for one from a session that went on for the
    /// same client before.
    pub session_shortfall_acknowledged: bool,
}

impl CodeRequest {
    /// Whether an approval may bind `patient` to this request: any patient (or
    /// none) when its launch bound no patient, otherwise exactly the launch's.
    #[must_use]
    pub fn admits_patient(&self, patient: Option<&str>) -> bool {
        match self.launch_bound_patient.as_deref() {
            None => true,
            Some(launch_bound_patient) => patient == Some(launch_bound_patient),
        }
    }
}

/// What a device-code request carries beyond the common core.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceRequest {
    /// The code the device shows its user, which the Owner enters at the
    /// device page.
    pub user_code: String,
    /// The name the device gave itself (an RFC 8628 extension), or the one
    /// the approver settled on; `None` falls back to the client's name.
    pub device_name: Option<String>,
    /// The device's last `/oauth/token` poll, for the §3.5 slow-down.
    pub last_polled_at: Option<DateTime<Utc>>,
}

/// What a browser pairing carries beyond the common core.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairingRequest {
    /// The code the pairing page shows, which the Owner confirms at the
    /// device page.
    pub user_code: String,
    /// The name the browser goes by on the Owner's card: one it gave itself,
    /// one taken from its user agent, or the one the approver settled on.
    pub browser_name: String,
    /// The pairing page's last poll, for the slow-down.
    pub last_polled_at: Option<DateTime<Utc>>,
}

/// A request the Owner decides: the core every kind shares, its lifecycle
/// state, and what its [`RequestKind`] adds. The fields are private: a request
/// is started by [`new`](Self::new) and changed only by its transitions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthorizationRequest {
    /// The device-flow `device_code`, a browser pairing's pairing code, or
    /// for a code request an internal UUID.
    id: String,
    client_id: String,
    requested_scopes: Vec<String>,
    requested_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
    status: RequestStatus,
    /// Present exactly when `status` is approved or claimed.
    approval: Option<Approval>,
    kind: RequestKind,
}

/// How a request is started: its key, its client, what it asks for, how long
/// it stays pending, and what its kind carries.
pub struct NewAuthorizationRequest {
    pub id: String,
    pub client_id: String,
    pub requested_scopes: Vec<String>,
    pub ttl: Duration,
    pub kind: RequestKind,
}

/// A request as stored, for the store to restore an entity from. Restoring
/// checks the one invariant the columns can break: a request carries an
/// approval exactly when it is approved or claimed.
pub struct StoredAuthorizationRequest {
    pub id: String,
    pub client_id: String,
    pub requested_scopes: Vec<String>,
    pub requested_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub status: RequestStatus,
    pub approval: Option<Approval>,
    pub kind: RequestKind,
}

/// The part of a request's state a concurrent transition can change under
/// another: its status, and whether a code request's browser has gone on past
/// its limited page (always `true` for the other kinds). A transition lands
/// only where the row is still in the phase it was read in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RequestPhase {
    pub status: RequestStatus,
    pub session_shortfall_acknowledged: bool,
}

/// A request changed by one of its transitions, with the phase it was read in.
/// Only a transition builds one, and the store's guarded replace writes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestTransition {
    read_in: RequestPhase,
    request: AuthorizationRequest,
}

impl RequestTransition {
    /// The phase the request was read in, which the row must still be in for
    /// the transition to land.
    #[must_use]
    pub fn read_in(&self) -> RequestPhase {
        self.read_in
    }

    /// The request as the transition leaves it.
    #[must_use]
    pub fn request(&self) -> &AuthorizationRequest {
        &self.request
    }

    /// The request as the transition leaves it, giving up the phase.
    #[must_use]
    pub fn into_request(self) -> AuthorizationRequest {
        self.request
    }
}

/// Why a transition doesn't apply to a request as read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransitionRefused {
    /// The request is no longer pending at `now`: decided, claimed, or past
    /// its expiry.
    NotPending,
    /// The code request isn't waiting on its browser's limited page: its
    /// browser has already gone on.
    NotWaitingOnLimitedPage,
    /// The request isn't approved and unexpired, so there is nothing to claim.
    NotClaimable,
    /// The transition is for another kind of request.
    OtherKind,
}

/// A malformed row: an approval on a request that is neither approved nor
/// claimed, or none on one that is.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("authorization request {id} is {status} but its approval disagrees")]
pub struct InconsistentApproval {
    pub id: String,
    pub status: RequestStatus,
}

impl AuthorizationRequest {
    /// A pending request started at `now`, expiring `ttl` later.
    #[must_use]
    pub fn new(new: NewAuthorizationRequest, now: DateTime<Utc>) -> Self {
        AuthorizationRequest {
            id: new.id,
            client_id: new.client_id,
            requested_scopes: new.requested_scopes,
            requested_at: now,
            expires_at: now + new.ttl,
            status: RequestStatus::Pending,
            approval: None,
            kind: new.kind,
        }
    }

    /// The request a stored row holds.
    ///
    /// # Errors
    ///
    /// [`InconsistentApproval`] when the row carries an approval exactly when
    /// its status says it shouldn't.
    pub fn restore(stored: StoredAuthorizationRequest) -> Result<Self, InconsistentApproval> {
        let approval_expected = matches!(
            stored.status,
            RequestStatus::Approved | RequestStatus::Claimed
        );
        if approval_expected != stored.approval.is_some() {
            return Err(InconsistentApproval {
                id: stored.id,
                status: stored.status,
            });
        }
        Ok(AuthorizationRequest {
            id: stored.id,
            client_id: stored.client_id,
            requested_scopes: stored.requested_scopes,
            requested_at: stored.requested_at,
            expires_at: stored.expires_at,
            status: stored.status,
            approval: stored.approval,
            kind: stored.kind,
        })
    }

    #[must_use]
    pub fn id(&self) -> &str {
        &self.id
    }

    /// The client that made the request.
    #[must_use]
    pub fn client_id(&self) -> &str {
        &self.client_id
    }

    /// The scopes the client asked for.
    #[must_use]
    pub fn requested_scopes(&self) -> &[String] {
        &self.requested_scopes
    }

    /// When the request started.
    #[must_use]
    pub fn requested_at(&self) -> DateTime<Utc> {
        self.requested_at
    }

    /// The instant the request stops being pending.
    #[must_use]
    pub fn expires_at(&self) -> DateTime<Utc> {
        self.expires_at
    }

    #[must_use]
    pub fn status(&self) -> RequestStatus {
        self.status
    }

    /// What the Owner approved: present exactly when the request is approved
    /// or claimed.
    #[must_use]
    pub fn approval(&self) -> Option<&Approval> {
        self.approval.as_ref()
    }

    #[must_use]
    pub fn kind(&self) -> &RequestKind {
        &self.kind
    }

    /// The stored discriminant of the request's kind.
    #[must_use]
    pub fn grant_type(&self) -> GrantType {
        match self.kind {
            RequestKind::AuthorizationCode(_) => GrantType::AuthorizationCode,
            RequestKind::DeviceCode(_) => GrantType::DeviceCode,
            RequestKind::BrowserPairing(_) => GrantType::BrowserPairing,
        }
    }

    /// What a code request carries, or `None` for another kind.
    #[must_use]
    pub fn code(&self) -> Option<&CodeRequest> {
        match &self.kind {
            RequestKind::AuthorizationCode(code_request) => Some(code_request),
            RequestKind::DeviceCode(_) | RequestKind::BrowserPairing(_) => None,
        }
    }

    /// What a device request carries, or `None` for another kind.
    #[must_use]
    pub fn device(&self) -> Option<&DeviceRequest> {
        match &self.kind {
            RequestKind::DeviceCode(device_request) => Some(device_request),
            RequestKind::AuthorizationCode(_) | RequestKind::BrowserPairing(_) => None,
        }
    }

    /// What a browser pairing carries, or `None` for another kind.
    #[must_use]
    pub fn pairing(&self) -> Option<&PairingRequest> {
        match &self.kind {
            RequestKind::BrowserPairing(pairing_request) => Some(pairing_request),
            RequestKind::AuthorizationCode(_) | RequestKind::DeviceCode(_) => None,
        }
    }

    /// The code the device page looks the request up by: a device's or a
    /// pairing's `user_code`; `None` for a code request, keyed by its id.
    #[must_use]
    pub fn user_code(&self) -> Option<&str> {
        match &self.kind {
            RequestKind::DeviceCode(device_request) => Some(&device_request.user_code),
            RequestKind::BrowserPairing(pairing_request) => Some(&pairing_request.user_code),
            RequestKind::AuthorizationCode(_) => None,
        }
    }

    /// Whether the request is past its expiry at `now`.
    #[must_use]
    pub fn is_expired_at(&self, now: DateTime<Utc>) -> bool {
        self.expires_at <= now
    }

    /// Whether the request still awaits a decision at `now`: pending, and not
    /// past its expiry.
    #[must_use]
    pub fn is_pending_at(&self, now: DateTime<Utc>) -> bool {
        self.status == RequestStatus::Pending && !self.is_expired_at(now)
    }

    /// The phase the request is in, as read.
    #[must_use]
    pub fn phase(&self) -> RequestPhase {
        RequestPhase {
            status: self.status,
            session_shortfall_acknowledged: self
                .code()
                .is_none_or(|code_request| code_request.session_shortfall_acknowledged),
        }
    }

    /// This request, pending at `now` and of the code kind, as a
    /// [`PendingCodeRequest`]; `None` otherwise.
    #[must_use]
    pub fn into_pending_code(self, now: DateTime<Utc>) -> Option<PendingCodeRequest> {
        if !self.is_pending_at(now) {
            return None;
        }
        let code_request = self.code()?.clone();
        Some(PendingCodeRequest {
            request: self,
            code_request,
        })
    }

    /// Approve the code request at `now` with `approval`.
    ///
    /// # Errors
    ///
    /// [`TransitionRefused::NotPending`]; [`TransitionRefused::OtherKind`]
    /// for a device request or a pairing.
    pub fn approve_code(
        &self,
        approval: Approval,
        now: DateTime<Utc>,
    ) -> Result<RequestTransition, TransitionRefused> {
        self.require_pending(now)?;
        self.code().ok_or(TransitionRefused::OtherKind)?;
        Ok(self.approved(approval, self.kind.clone()))
    }

    /// Approve the device request at `now` with `approval`, naming the device
    /// `device_name` (`None` keeps the name it has).
    ///
    /// # Errors
    ///
    /// [`TransitionRefused::NotPending`]; [`TransitionRefused::OtherKind`]
    /// for another kind.
    pub fn approve_device(
        &self,
        approval: Approval,
        device_name: Option<String>,
        now: DateTime<Utc>,
    ) -> Result<RequestTransition, TransitionRefused> {
        self.require_pending(now)?;
        let device_request = self.device().ok_or(TransitionRefused::OtherKind)?;
        Ok(self.approved(
            approval,
            RequestKind::DeviceCode(DeviceRequest {
                device_name: device_name.or_else(|| device_request.device_name.clone()),
                ..device_request.clone()
            }),
        ))
    }

    /// Approve the pairing at `now` with `approval`, naming the browser
    /// `browser_name` (`None` keeps the name it has).
    ///
    /// # Errors
    ///
    /// [`TransitionRefused::NotPending`]; [`TransitionRefused::OtherKind`]
    /// for another kind.
    pub fn approve_pairing(
        &self,
        approval: Approval,
        browser_name: Option<String>,
        now: DateTime<Utc>,
    ) -> Result<RequestTransition, TransitionRefused> {
        self.require_pending(now)?;
        let pairing_request = self.pairing().ok_or(TransitionRefused::OtherKind)?;
        Ok(self.approved(
            approval,
            RequestKind::BrowserPairing(PairingRequest {
                browser_name: browser_name.unwrap_or_else(|| pairing_request.browser_name.clone()),
                ..pairing_request.clone()
            }),
        ))
    }

    /// Deny the request at `now`.
    ///
    /// # Errors
    ///
    /// [`TransitionRefused::NotPending`] for a request no longer pending.
    pub fn deny(&self, now: DateTime<Utc>) -> Result<RequestTransition, TransitionRefused> {
        self.require_pending(now)?;
        Ok(self.transition(AuthorizationRequest {
            status: RequestStatus::Denied,
            ..self.clone()
        }))
    }

    /// Raise the code request for the Owner at `now`: it stops being
    /// decidable in the browser that made it, so the host notifies for it.
    /// Decides nothing.
    ///
    /// # Errors
    ///
    /// [`TransitionRefused::NotPending`]; [`TransitionRefused::OtherKind`]
    /// for a device request or a pairing.
    pub fn raise_for_owner(
        &self,
        now: DateTime<Utc>,
    ) -> Result<RequestTransition, TransitionRefused> {
        self.require_pending(now)?;
        let code_request = self.code().ok_or(TransitionRefused::OtherKind)?;
        Ok(self.transition(AuthorizationRequest {
            kind: RequestKind::AuthorizationCode(CodeRequest {
                decidable_in_requesting_browser: false,
                ..code_request.clone()
            }),
            ..self.clone()
        }))
    }

    /// Record at `now` that the browser that made the code request goes on
    /// although its browser session falls short of it, and give the request
    /// `ttl` more from `now`. Decides nothing.
    ///
    /// # Errors
    ///
    /// [`TransitionRefused::NotPending`];
    /// [`TransitionRefused::NotWaitingOnLimitedPage`] when it has gone on
    /// already; [`TransitionRefused::OtherKind`] for another kind.
    pub fn acknowledge_session_shortfall(
        &self,
        ttl: Duration,
        now: DateTime<Utc>,
    ) -> Result<RequestTransition, TransitionRefused> {
        let code_request = self.waiting_on_limited_page(now)?;
        Ok(self.transition(AuthorizationRequest {
            expires_at: now + ttl,
            kind: RequestKind::AuthorizationCode(CodeRequest {
                session_shortfall_acknowledged: true,
                ..code_request.clone()
            }),
            ..self.clone()
        }))
    }

    /// Deny the code request at `now` while it still waits on its browser's
    /// limited page: the page's Cancel, or a client disabled before the
    /// browser went on.
    ///
    /// # Errors
    ///
    /// As [`acknowledge_session_shortfall`](Self::acknowledge_session_shortfall).
    pub fn deny_on_limited_page(
        &self,
        now: DateTime<Utc>,
    ) -> Result<RequestTransition, TransitionRefused> {
        self.waiting_on_limited_page(now)?;
        Ok(self.transition(AuthorizationRequest {
            status: RequestStatus::Denied,
            ..self.clone()
        }))
    }

    /// Claim the approved request at `now`, once: the poll of the device or
    /// pairing page that redeems the Owner's approval.
    ///
    /// # Errors
    ///
    /// [`TransitionRefused::NotClaimable`] for a request not approved, or past
    /// its expiry.
    pub fn claim(&self, now: DateTime<Utc>) -> Result<RequestTransition, TransitionRefused> {
        if self.status != RequestStatus::Approved || self.is_expired_at(now) {
            return Err(TransitionRefused::NotClaimable);
        }
        Ok(self.transition(AuthorizationRequest {
            status: RequestStatus::Claimed,
            ..self.clone()
        }))
    }

    /// Stamp the pending device request's poll at `now`, for the next poll's
    /// slow-down.
    ///
    /// # Errors
    ///
    /// [`TransitionRefused::NotPending`]; [`TransitionRefused::OtherKind`]
    /// for another kind.
    pub fn stamp_device_poll(
        &self,
        now: DateTime<Utc>,
    ) -> Result<RequestTransition, TransitionRefused> {
        self.require_pending(now)?;
        let device_request = self.device().ok_or(TransitionRefused::OtherKind)?;
        Ok(self.transition(AuthorizationRequest {
            kind: RequestKind::DeviceCode(DeviceRequest {
                last_polled_at: Some(now),
                ..device_request.clone()
            }),
            ..self.clone()
        }))
    }

    /// Stamp the pending pairing's poll at `now`, for the next poll's
    /// slow-down, and record the `browser_name` its page now gives.
    ///
    /// # Errors
    ///
    /// [`TransitionRefused::NotPending`]; [`TransitionRefused::OtherKind`]
    /// for another kind.
    pub fn stamp_pairing_poll(
        &self,
        browser_name: &str,
        now: DateTime<Utc>,
    ) -> Result<RequestTransition, TransitionRefused> {
        self.require_pending(now)?;
        let pairing_request = self.pairing().ok_or(TransitionRefused::OtherKind)?;
        Ok(self.transition(AuthorizationRequest {
            kind: RequestKind::BrowserPairing(PairingRequest {
                browser_name: browser_name.to_owned(),
                last_polled_at: Some(now),
                ..pairing_request.clone()
            }),
            ..self.clone()
        }))
    }

    /// Refuse a transition on a request no longer pending at `now`.
    fn require_pending(&self, now: DateTime<Utc>) -> Result<(), TransitionRefused> {
        if self.is_pending_at(now) {
            Ok(())
        } else {
            Err(TransitionRefused::NotPending)
        }
    }

    /// The approved request with `approval`, its kind's payload `kind`.
    fn approved(&self, approval: Approval, kind: RequestKind) -> RequestTransition {
        self.transition(AuthorizationRequest {
            status: RequestStatus::Approved,
            approval: Some(approval),
            kind,
            ..self.clone()
        })
    }

    /// What the code request carries, when it is pending at `now` and still
    /// waits on its browser's limited page.
    fn waiting_on_limited_page(
        &self,
        now: DateTime<Utc>,
    ) -> Result<&CodeRequest, TransitionRefused> {
        self.require_pending(now)?;
        let code_request = self.code().ok_or(TransitionRefused::OtherKind)?;
        if code_request.session_shortfall_acknowledged {
            return Err(TransitionRefused::NotWaitingOnLimitedPage);
        }
        Ok(code_request)
    }

    /// `changed`, read in this request's phase.
    fn transition(&self, changed: AuthorizationRequest) -> RequestTransition {
        RequestTransition {
            read_in: self.phase(),
            request: changed,
        }
    }
}

/// A code request that was pending when it was read: what the consent and
/// limited-page flows load, and what
/// `RequestApprover::approve_for_code`
/// approves. Holding the code payload beside the request (a copy, built only
/// by [`AuthorizationRequest::into_pending_code`]) answers the code-only
/// questions without a kind check at every use.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingCodeRequest {
    request: AuthorizationRequest,
    code_request: CodeRequest,
}

impl PendingCodeRequest {
    /// The request as read.
    #[must_use]
    pub fn request(&self) -> &AuthorizationRequest {
        &self.request
    }

    /// What the code request carries.
    #[must_use]
    pub fn code(&self) -> &CodeRequest {
        &self.code_request
    }

    /// The request as read, giving up the code view.
    #[must_use]
    pub fn into_request(self) -> AuthorizationRequest {
        self.request
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn at(minutes: i64) -> DateTime<Utc> {
        DateTime::from_timestamp(1_800_000_000, 0).expect("in range") + Duration::minutes(minutes)
    }

    /// A request started at minute 0, pending until minute 5, carrying `kind`.
    fn started(kind: RequestKind) -> AuthorizationRequest {
        AuthorizationRequest::new(
            NewAuthorizationRequest {
                id: "req-1".to_owned(),
                client_id: "app".to_owned(),
                requested_scopes: vec!["openid".to_owned()],
                ttl: Duration::minutes(5),
                kind,
            },
            at(0),
        )
    }

    fn code(session_shortfall_acknowledged: bool) -> RequestKind {
        RequestKind::AuthorizationCode(CodeRequest {
            redirect_uri: Url::parse("https://app.example/cb").expect("a URL"),
            code_challenge: "c".repeat(43),
            client_state: "state".to_owned(),
            sid: "sid-1".to_owned(),
            launch: None,
            launch_bound_patient: None,
            pre_approved_scopes: Vec::new(),
            decidable_in_requesting_browser: true,
            session_shortfall_acknowledged,
        })
    }

    fn device() -> RequestKind {
        RequestKind::DeviceCode(DeviceRequest {
            user_code: "WILD-FLWR".to_owned(),
            device_name: Some("Kitchen iPad".to_owned()),
            last_polled_at: None,
        })
    }

    fn pairing() -> RequestKind {
        RequestKind::BrowserPairing(PairingRequest {
            user_code: "PAIR-CODE".to_owned(),
            browser_name: "Firefox on Linux".to_owned(),
            last_polled_at: None,
        })
    }

    fn approval() -> Approval {
        Approval {
            granted_scopes: vec!["openid".to_owned()],
            patient: Some("Patient/1".to_owned()),
        }
    }

    fn phase(status: RequestStatus, session_shortfall_acknowledged: bool) -> RequestPhase {
        RequestPhase {
            status,
            session_shortfall_acknowledged,
        }
    }

    /// A new request is pending until its expiry, and expired from it on.
    #[test]
    fn a_new_request_is_pending_until_it_expires() {
        let request = started(device());
        assert_eq!(request.requested_at(), at(0));
        assert_eq!(request.expires_at(), at(5));
        assert!(request.is_pending_at(at(4)));
        assert!(!request.is_expired_at(at(4)));
        assert!(request.is_expired_at(at(5)));
        assert!(!request.is_pending_at(at(5)));
        assert_eq!(request.approval(), None);
    }

    /// Approving a code request records the approval, and is read in the
    /// pending phase; past expiry, or once decided, it is refused.
    #[test]
    fn approve_code_records_the_approval() {
        let request = started(code(true));
        let approved = request.approve_code(approval(), at(1)).expect("approves");
        assert_eq!(approved.read_in(), phase(RequestStatus::Pending, true));
        let approved = approved.into_request();
        assert_eq!(approved.status(), RequestStatus::Approved);
        assert_eq!(approved.approval(), Some(&approval()));
        assert_eq!(approved.kind(), request.kind());
        assert_eq!(
            request.approve_code(approval(), at(5)),
            Err(TransitionRefused::NotPending)
        );
        assert_eq!(
            approved.approve_code(approval(), at(1)),
            Err(TransitionRefused::NotPending)
        );
    }

    /// Approving a device request records the approval and the device's
    /// settled name; `None` keeps the name it has.
    #[test]
    fn approve_device_records_the_approval_and_the_device_s_name() {
        let request = started(device());
        let approved = request
            .approve_device(approval(), Some("Reception iPad".to_owned()), at(1))
            .expect("approves")
            .into_request();
        assert_eq!(approved.status(), RequestStatus::Approved);
        assert_eq!(approved.approval(), Some(&approval()));
        assert_eq!(
            approved
                .device()
                .and_then(|device| device.device_name.as_deref()),
            Some("Reception iPad")
        );
        let kept_name = request
            .approve_device(approval(), None, at(1))
            .expect("approves");
        assert_eq!(kept_name.request().kind(), request.kind());
        assert_eq!(
            approved.approve_device(approval(), None, at(1)),
            Err(TransitionRefused::NotPending)
        );
    }

    /// Approving a pairing records the approval and the browser's settled
    /// name; `None` keeps the name it has.
    #[test]
    fn approve_pairing_records_the_approval_and_the_browser_s_name() {
        let request = started(pairing());
        let renamed = request
            .approve_pairing(approval(), Some("Ruth's laptop".to_owned()), at(1))
            .expect("approves")
            .into_request();
        assert_eq!(renamed.status(), RequestStatus::Approved);
        assert_eq!(renamed.approval(), Some(&approval()));
        assert_eq!(
            renamed
                .pairing()
                .map(|pairing| pairing.browser_name.as_str()),
            Some("Ruth's laptop")
        );
        let kept_name = request
            .approve_pairing(approval(), None, at(1))
            .expect("approves");
        assert_eq!(kept_name.request().kind(), request.kind());
    }

    /// Each kind's approval refuses the other kinds.
    #[test]
    fn approvals_refuse_another_kind() {
        assert_eq!(
            started(device()).approve_code(approval(), at(1)),
            Err(TransitionRefused::OtherKind)
        );
        assert_eq!(
            started(pairing()).approve_device(approval(), None, at(1)),
            Err(TransitionRefused::OtherKind)
        );
        assert_eq!(
            started(code(true)).approve_pairing(approval(), None, at(1)),
            Err(TransitionRefused::OtherKind)
        );
    }

    /// Denying a pending request decides it, with no approval.
    #[test]
    fn deny_decides_a_pending_request() {
        let request = started(code(true));
        let denied = request.deny(at(1)).expect("denies").into_request();
        assert_eq!(denied.status(), RequestStatus::Denied);
        assert_eq!(denied.approval(), None);
        assert_eq!(denied.deny(at(1)), Err(TransitionRefused::NotPending));
    }

    /// Raising a code request for the Owner clears only whether it is
    /// decidable in the requesting browser.
    #[test]
    fn raise_for_owner_stops_a_code_request_counting_as_decidable_where_it_was_made() {
        let raised = started(code(true))
            .raise_for_owner(at(1))
            .expect("raises")
            .into_request();
        assert_eq!(raised.status(), RequestStatus::Pending);
        assert_eq!(
            raised
                .code()
                .map(|code| code.decidable_in_requesting_browser),
            Some(false)
        );
        assert_eq!(
            started(device()).raise_for_owner(at(1)),
            Err(TransitionRefused::OtherKind)
        );
    }

    /// Acknowledging the session shortfall moves the phase on and restarts
    /// the expiry; it applies once, and only to a code request still waiting.
    #[test]
    fn acknowledge_session_shortfall_goes_on_past_the_limited_page_once() {
        let waiting = started(code(false));
        let acknowledged = waiting
            .acknowledge_session_shortfall(Duration::minutes(5), at(3))
            .expect("acknowledges");
        assert_eq!(acknowledged.read_in(), phase(RequestStatus::Pending, false));
        let acknowledged = acknowledged.into_request();
        assert_eq!(acknowledged.phase(), phase(RequestStatus::Pending, true));
        assert_eq!(acknowledged.expires_at(), at(8));
        assert_eq!(
            acknowledged.acknowledge_session_shortfall(Duration::minutes(5), at(4)),
            Err(TransitionRefused::NotWaitingOnLimitedPage)
        );
        assert_eq!(
            started(device()).acknowledge_session_shortfall(Duration::minutes(5), at(1)),
            Err(TransitionRefused::OtherKind)
        );
    }

    /// Denying on the limited page applies only while the request waits
    /// there, read in the same phase a Continue is, so only one lands.
    #[test]
    fn deny_on_limited_page_applies_only_while_the_request_waits_there() {
        let waiting = started(code(false));
        let cancelled = waiting.deny_on_limited_page(at(1)).expect("cancels");
        assert_eq!(cancelled.read_in(), phase(RequestStatus::Pending, false));
        assert_eq!(cancelled.request().status(), RequestStatus::Denied);
        assert_eq!(
            started(code(true)).deny_on_limited_page(at(1)),
            Err(TransitionRefused::NotWaitingOnLimitedPage)
        );
    }

    /// An approved, unexpired request is claimed once, keeping its approval;
    /// a pending one, a claimed one and an expired one are not claimable.
    #[test]
    fn claim_redeems_an_approved_request_once() {
        let request = started(device());
        let approved = request
            .approve_device(approval(), None, at(1))
            .expect("approves")
            .into_request();
        let claimed = approved.claim(at(2)).expect("claims");
        assert_eq!(claimed.read_in(), phase(RequestStatus::Approved, true));
        let claimed = claimed.into_request();
        assert_eq!(claimed.status(), RequestStatus::Claimed);
        assert_eq!(claimed.approval(), Some(&approval()));
        assert_eq!(claimed.claim(at(2)), Err(TransitionRefused::NotClaimable));
        assert_eq!(request.claim(at(2)), Err(TransitionRefused::NotClaimable));
        assert_eq!(approved.claim(at(5)), Err(TransitionRefused::NotClaimable));
    }

    /// A device poll stamp records the poll and leaves the phase as it was.
    #[test]
    fn stamp_device_poll_records_the_poll() {
        let stamped = started(device()).stamp_device_poll(at(1)).expect("stamps");
        assert_eq!(stamped.read_in(), stamped.request().phase());
        assert_eq!(
            stamped
                .request()
                .device()
                .and_then(|device| device.last_polled_at),
            Some(at(1))
        );
        assert_eq!(
            started(pairing()).stamp_device_poll(at(1)),
            Err(TransitionRefused::OtherKind)
        );
    }

    /// A pairing poll stamp records the poll and the browser's latest name.
    #[test]
    fn stamp_pairing_poll_records_the_poll_and_the_browser_s_name() {
        let stamped = started(pairing())
            .stamp_pairing_poll("Kitchen laptop", at(1))
            .expect("stamps")
            .into_request();
        assert_eq!(
            stamped.pairing(),
            Some(&PairingRequest {
                user_code: "PAIR-CODE".to_owned(),
                browser_name: "Kitchen laptop".to_owned(),
                last_polled_at: Some(at(1)),
            })
        );
        assert_eq!(
            started(pairing()).stamp_pairing_poll("Kitchen laptop", at(5)),
            Err(TransitionRefused::NotPending)
        );
    }

    /// Restoring a row checks that the approval agrees with the status.
    #[test]
    fn restore_refuses_an_approval_that_disagrees_with_the_status() {
        let stored = |status, approval| StoredAuthorizationRequest {
            id: "req-1".to_owned(),
            client_id: "app".to_owned(),
            requested_scopes: Vec::new(),
            requested_at: at(0),
            expires_at: at(5),
            status,
            approval,
            kind: device(),
        };
        assert!(
            AuthorizationRequest::restore(stored(RequestStatus::Claimed, Some(approval()))).is_ok()
        );
        assert_eq!(
            AuthorizationRequest::restore(stored(RequestStatus::Approved, None)),
            Err(InconsistentApproval {
                id: "req-1".to_owned(),
                status: RequestStatus::Approved,
            })
        );
        assert!(
            AuthorizationRequest::restore(stored(RequestStatus::Denied, Some(approval()))).is_err()
        );
    }

    /// A code request pending at `now` is a pending code request; anything
    /// else is not.
    #[test]
    fn into_pending_code_takes_only_a_pending_code_request() {
        let pending = started(code(true))
            .into_pending_code(at(1))
            .expect("a pending code request");
        assert_eq!(Some(pending.code()), pending.request().code());
        assert!(started(code(true)).into_pending_code(at(5)).is_none());
        assert!(started(device()).into_pending_code(at(1)).is_none());
    }
}
