//! Authorization requests — a request the Owner decides, from the moment it
//! starts to its decision and, for the two flows a poll redeems, the single
//! claim of that decision. Each flow is its own struct, with its own fields,
//! states and transitions:
//!
//! - [`CodeRequest`]: an RFC 6749 §4.1.1 authorization request, parked by
//!   `/oauth/authorize`;
//! - [`DeviceRequest`]: an RFC 8628 §3.1 device authorization request;
//! - [`PairingRequest`]: a browser asking for a browser session at
//!   `/oauth/pair`, which is no OAuth grant;
//! - [`SessionWideningRequest`]: a browser asking, from its limited page, for
//!   its browser session to hold more, which is no OAuth grant either.
//!
//! The device and pairing flows share their shape (a `user_code` the Owner
//! enters, a poll that claims the approval), in [`polled`]; a session
//! widening is claimed by a poll too, but is keyed by its id. The
//! [`AuthorizationRequest`] enum is only for the reads that cross flows: the
//! Owner prompt, a consent named by its key, and a lookup by id.
//!
//! Every change is a transition on the flow's struct: it reads the request
//! as loaded, takes `now`, and answers with the changed request, or a refusal
//! where one can really happen. The store writes it back with a guarded
//! replace that lands only while the row still has the status the request
//! was read with, so of two transitions read from one row the first to land
//! wins, and the other changes nothing.
//!
//! Expiry is derived from `expires_at`, never stored as a status.

pub mod approval;
pub mod code;
pub mod device;
pub mod pairing;
pub mod polled;
pub mod session_widening;

use chrono::{DateTime, Duration, Utc};
use diesel::deserialize::FromSqlRow;
use diesel::expression::AsExpression;
use strum::{AsRefStr, Display, EnumString};

use code::CodeRequest;
use device::DeviceRequest;
use pairing::PairingRequest;
use polled::Polled as _;
use session_widening::SessionWideningRequest;

/// Minimum polling interval the device-code flow enforces (RFC 8628 §3.5) —
/// advertised as `interval` in the device-authorization response and enforced
/// against a device's or pairing's last poll with `slow_down`.
pub const DEVICE_CODE_POLL_INTERVAL: Duration = Duration::seconds(5);

/// The flow a request belongs to: one of the two OAuth grant flows, or a
/// browser pairing or session widening, which are no OAuth grant. The store
/// keeps a device request's or pairing's flow in its `flow` column, and the
/// cross-kind `grants` view tags its rows with the flow that earned them.
///
/// `strum` derives the `&str` ↔ enum conversions from the `snake_case` variant
/// names — `AuthorizationCode` → `"authorization_code"`, `DeviceCode` →
/// `"device_code"`, matching the RFC 6749 / RFC 8628 `grant_type` values,
/// `BrowserPairing` → `"browser_pairing"` and `SessionWidening` →
/// `"session_widening"`.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, EnumString, AsRefStr, Display, AsExpression, FromSqlRow,
)]
#[strum(serialize_all = "snake_case")]
#[diesel(sql_type = diesel::sql_types::Text)]
pub enum FlowType {
    /// RFC 6749 §4.1 authorization-code flow.
    AuthorizationCode,
    /// RFC 8628 device-code flow.
    DeviceCode,
    /// A browser asking the Owner for a browser session at `/oauth/pair`.
    BrowserPairing,
    /// A browser asking the Owner, from its limited page, to widen its
    /// browser session.
    SessionWidening,
}

/// Where a request stands, as stored in the `status` column: the state of a
/// [`CodeRequest`] or a polled request without the approval it carries. The
/// store's guarded replace compares it.
///
/// `strum` derives the `&str` ↔ enum conversions from the `snake_case` variant
/// names — `AwaitingLimitedPage` → `"awaiting_limited_page"`, `Pending` →
/// `"pending"`, and so on.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, EnumString, AsRefStr, Display, AsExpression, FromSqlRow,
)]
#[strum(serialize_all = "snake_case")]
#[diesel(sql_type = diesel::sql_types::Text)]
pub enum RequestStatus {
    /// A code request waiting on its browser's limited page: the Owner isn't
    /// asked about it, and nothing decides it.
    AwaitingLimitedPage,
    /// Waiting for the Owner's decision, until it expires.
    Pending,
    /// The Owner approved it.
    Approved,
    /// The Owner, or the browser that made it, declined it.
    Denied,
    /// A device request, browser pairing or session widening whose poll
    /// redeemed the approval, once (RFC 8628 §3.4 single use).
    Claimed,
}

/// A transition refused because the request no longer waits for the Owner at
/// `now`: decided, claimed, or past its expiry (and, for a code request,
/// while it still waits on its browser's limited page).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NotPending;

/// A request of any flow, for the reads that cross flows: the Owner prompt,
/// a consent named by its key, and a lookup by id. A read or write within one
/// flow takes that flow's struct instead.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthorizationRequest {
    /// An authorization-code request.
    Code(CodeRequest),
    /// A device-code request.
    Device(DeviceRequest),
    /// A browser pairing.
    Pairing(PairingRequest),
    /// A session widening.
    SessionWidening(SessionWideningRequest),
}

impl AuthorizationRequest {
    /// The request's key: the device-flow `device_code`, a browser pairing's
    /// pairing code, or for a code request or session widening an internal
    /// UUID.
    #[must_use]
    pub fn id(&self) -> &str {
        match self {
            AuthorizationRequest::Code(code_request) => &code_request.id,
            AuthorizationRequest::Device(device_request) => &device_request.id,
            AuthorizationRequest::Pairing(pairing_request) => &pairing_request.id,
            AuthorizationRequest::SessionWidening(widening_request) => &widening_request.id,
        }
    }

    /// The client that made the request; for a session widening, the app
    /// whose request the session fell short of.
    #[must_use]
    pub fn client_id(&self) -> &str {
        match self {
            AuthorizationRequest::Code(code_request) => &code_request.client_id,
            AuthorizationRequest::Device(device_request) => &device_request.client_id,
            AuthorizationRequest::Pairing(pairing_request) => &pairing_request.client_id,
            AuthorizationRequest::SessionWidening(widening_request) => &widening_request.client_id,
        }
    }

    /// The scopes the client asked for.
    #[must_use]
    pub fn requested_scopes(&self) -> &[String] {
        match self {
            AuthorizationRequest::Code(code_request) => &code_request.requested_scopes,
            AuthorizationRequest::Device(device_request) => &device_request.requested_scopes,
            AuthorizationRequest::Pairing(pairing_request) => &pairing_request.requested_scopes,
            AuthorizationRequest::SessionWidening(widening_request) => {
                &widening_request.requested_scopes
            }
        }
    }

    /// When the request started.
    #[must_use]
    pub fn requested_at(&self) -> DateTime<Utc> {
        match self {
            AuthorizationRequest::Code(code_request) => code_request.requested_at,
            AuthorizationRequest::Device(device_request) => device_request.requested_at,
            AuthorizationRequest::Pairing(pairing_request) => pairing_request.requested_at,
            AuthorizationRequest::SessionWidening(widening_request) => {
                widening_request.requested_at
            }
        }
    }

    /// The instant the request stops waiting for a decision.
    #[must_use]
    pub fn expires_at(&self) -> DateTime<Utc> {
        match self {
            AuthorizationRequest::Code(code_request) => code_request.expires_at,
            AuthorizationRequest::Device(device_request) => device_request.expires_at,
            AuthorizationRequest::Pairing(pairing_request) => pairing_request.expires_at,
            AuthorizationRequest::SessionWidening(widening_request) => widening_request.expires_at,
        }
    }

    /// Where the request stands, without the approval it may carry.
    #[must_use]
    pub fn status(&self) -> RequestStatus {
        match self {
            AuthorizationRequest::Code(code_request) => code_request.state.status(),
            AuthorizationRequest::Device(device_request) => device_request.state.status(),
            AuthorizationRequest::Pairing(pairing_request) => pairing_request.state.status(),
            AuthorizationRequest::SessionWidening(widening_request) => {
                widening_request.state.status()
            }
        }
    }

    /// The flow the request belongs to, as stored.
    #[must_use]
    pub fn flow_type(&self) -> FlowType {
        match self {
            AuthorizationRequest::Code(_) => FlowType::AuthorizationCode,
            AuthorizationRequest::Device(_) => FlowType::DeviceCode,
            AuthorizationRequest::Pairing(_) => FlowType::BrowserPairing,
            AuthorizationRequest::SessionWidening(_) => FlowType::SessionWidening,
        }
    }

    /// The code the device page looks the request up by: a device's or a
    /// pairing's `user_code`; `None` for a code request or a session
    /// widening, keyed by its id.
    #[must_use]
    pub fn user_code(&self) -> Option<&str> {
        match self {
            AuthorizationRequest::Code(_) | AuthorizationRequest::SessionWidening(_) => None,
            AuthorizationRequest::Device(device_request) => Some(device_request.user_code()),
            AuthorizationRequest::Pairing(pairing_request) => Some(pairing_request.user_code()),
        }
    }

    /// Whether the request is past its expiry at `now`.
    #[must_use]
    pub fn is_expired_at(&self, now: DateTime<Utc>) -> bool {
        self.expires_at() <= now
    }

    /// Whether the request waits for the Owner's decision at `now`: pending
    /// and unexpired. A code request still on its browser's limited page
    /// doesn't: the Owner isn't asked about it yet.
    #[must_use]
    pub fn is_pending_at(&self, now: DateTime<Utc>) -> bool {
        self.status() == RequestStatus::Pending && !self.is_expired_at(now)
    }

    /// Whether nothing has decided the request by `now`: pending, or (for a
    /// code request) waiting on its browser's limited page, and unexpired.
    #[must_use]
    pub fn is_undecided_at(&self, now: DateTime<Utc>) -> bool {
        matches!(
            self.status(),
            RequestStatus::Pending | RequestStatus::AwaitingLimitedPage
        ) && !self.is_expired_at(now)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::authorization_request::code::NewCodeRequestArgs;
    use crate::domain::test_fake::fixture_code_args;

    /// The instant `minutes` after the tests' fixed start.
    fn at(minutes: i64) -> DateTime<Utc> {
        DateTime::from_timestamp(1_800_000_000, 0).expect("in range") + Duration::minutes(minutes)
    }

    /// A code request started at minute 0, live until minute 5, on its
    /// limited page or not.
    fn code_request(awaits_limited_page: bool) -> AuthorizationRequest {
        AuthorizationRequest::Code(CodeRequest::new(
            NewCodeRequestArgs {
                awaits_limited_page,
                ..fixture_code_args("req-1", "app", vec!["openid".to_owned()])
            },
            at(0),
        ))
    }

    /// A request on its limited page is undecided but not pending: nothing
    /// has decided it, and the Owner isn't asked about it.
    #[test]
    fn a_request_on_its_limited_page_is_undecided_but_not_pending() {
        let waiting = code_request(true);
        assert_eq!(waiting.status(), RequestStatus::AwaitingLimitedPage);
        assert!(waiting.is_undecided_at(at(4)));
        assert!(!waiting.is_pending_at(at(4)));
        assert!(!waiting.is_undecided_at(at(5)));
    }

    /// A pending request is pending and undecided until it expires.
    #[test]
    fn a_pending_request_is_pending_and_undecided_until_it_expires() {
        let pending = code_request(false);
        assert_eq!(pending.id(), "req-1");
        assert_eq!(pending.flow_type(), FlowType::AuthorizationCode);
        assert_eq!(pending.user_code(), None);
        assert!(pending.is_pending_at(at(4)));
        assert!(pending.is_undecided_at(at(4)));
        assert!(pending.is_expired_at(at(5)));
        assert!(!pending.is_pending_at(at(5)));
        assert!(!pending.is_undecided_at(at(5)));
    }
}
