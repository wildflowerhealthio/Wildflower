//! The polled flows — a device request and a browser pairing. Both show a
//! `user_code` the Owner enters at the device page, are polled by what made
//! them until the Owner decides, and are claimed once by the poll that
//! redeems the approval. [`PolledState`] is their shared lifecycle, [`Polled`]
//! what they share, and [`PolledRequest`] either one, as the device page
//! loads it by its `user_code`.

use chrono::{DateTime, Utc};

use super::device::DeviceRequest;
use super::pairing::PairingRequest;
use super::{RequestStatus, DEVICE_CODE_POLL_INTERVAL};

/// Where a polled request stands, carrying the flow's approval `A` once the
/// Owner approved it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PolledState<A> {
    /// Waiting for the Owner's decision, until it expires.
    Pending,
    /// The Owner approved it; the next poll claims the approval.
    Approved(A),
    /// The Owner declined it.
    Denied,
    /// A poll redeemed the approval, once (RFC 8628 §3.4 single use). It keeps
    /// the approval it redeemed.
    Claimed(A),
}

impl<A> PolledState<A> {
    /// The state as stored, without its approval.
    #[must_use]
    pub fn status(&self) -> RequestStatus {
        match self {
            PolledState::Pending => RequestStatus::Pending,
            PolledState::Approved(_) => RequestStatus::Approved,
            PolledState::Denied => RequestStatus::Denied,
            PolledState::Claimed(_) => RequestStatus::Claimed,
        }
    }

    /// The approval the request carries: present exactly when it is approved
    /// or claimed.
    #[must_use]
    pub fn approval(&self) -> Option<&A> {
        match self {
            PolledState::Approved(approval) | PolledState::Claimed(approval) => Some(approval),
            PolledState::Pending | PolledState::Denied => None,
        }
    }
}

/// A claim refused: the request isn't approved, or is past its expiry, so
/// there is nothing to redeem.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NotClaimable;

/// What a device request and a browser pairing share: the code the Owner
/// enters, the poll that waits on the decision, and the claim that redeems it.
pub trait Polled: Sized {
    /// What the Owner's approval carries for this flow.
    type Approval: Clone;

    /// The code the device page looks the request up by, which the Owner
    /// enters or confirms there.
    fn user_code(&self) -> &str;

    /// The last poll, for the slow-down; `None` before the first.
    fn last_polled_at(&self) -> Option<DateTime<Utc>>;

    /// The instant the request stops waiting for a decision.
    fn expires_at(&self) -> DateTime<Utc>;

    /// Where the request stands.
    fn state(&self) -> &PolledState<Self::Approval>;

    /// Claim the approved request at `now`, once: the poll that redeems the
    /// Owner's approval.
    ///
    /// # Errors
    ///
    /// [`NotClaimable`] for a request not approved, or past its expiry.
    fn claim(&self, now: DateTime<Utc>) -> Result<Self, NotClaimable>;

    /// Whether the request is past its expiry at `now`.
    fn is_expired_at(&self, now: DateTime<Utc>) -> bool {
        self.expires_at() <= now
    }

    /// Whether the request waits for the Owner's decision at `now`: pending
    /// and unexpired.
    fn is_pending_at(&self, now: DateTime<Utc>) -> bool {
        matches!(self.state(), PolledState::Pending) && !self.is_expired_at(now)
    }

    /// Whether a poll at `now` comes sooner than [`DEVICE_CODE_POLL_INTERVAL`]
    /// after the last one, which answers `slow_down` (RFC 8628 §3.5).
    fn is_polled_too_soon_at(&self, now: DateTime<Utc>) -> bool {
        self.last_polled_at()
            .is_some_and(|last_polled_at| now - last_polled_at < DEVICE_CODE_POLL_INTERVAL)
    }
}

/// The claimed state of `request` at `now`: its approval, redeemed. The
/// flows' [`Polled::claim`] build on it.
pub(super) fn claimed_state<P: Polled>(
    request: &P,
    now: DateTime<Utc>,
) -> Result<PolledState<P::Approval>, NotClaimable> {
    match request.state() {
        PolledState::Approved(approval) if !request.is_expired_at(now) => {
            Ok(PolledState::Claimed(approval.clone()))
        }
        _ => Err(NotClaimable),
    }
}

/// A polled request of either flow, as the device page loads it by its
/// `user_code`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PolledRequest {
    /// A device-code request.
    Device(DeviceRequest),
    /// A browser pairing.
    Pairing(PairingRequest),
}

impl PolledRequest {
    /// The request's key: the `device_code`, or the pairing code.
    #[must_use]
    pub fn id(&self) -> &str {
        match self {
            PolledRequest::Device(device_request) => &device_request.id,
            PolledRequest::Pairing(pairing_request) => &pairing_request.id,
        }
    }

    /// The client that made the request.
    #[must_use]
    pub fn client_id(&self) -> &str {
        match self {
            PolledRequest::Device(device_request) => &device_request.client_id,
            PolledRequest::Pairing(pairing_request) => &pairing_request.client_id,
        }
    }

    /// The scopes the client asked for.
    #[must_use]
    pub fn requested_scopes(&self) -> &[String] {
        match self {
            PolledRequest::Device(device_request) => &device_request.requested_scopes,
            PolledRequest::Pairing(pairing_request) => &pairing_request.requested_scopes,
        }
    }

    /// The code the device page looks the request up by.
    #[must_use]
    pub fn user_code(&self) -> &str {
        match self {
            PolledRequest::Device(device_request) => device_request.user_code(),
            PolledRequest::Pairing(pairing_request) => pairing_request.user_code(),
        }
    }

    /// Whether the request waits for the Owner's decision at `now`.
    #[must_use]
    pub fn is_pending_at(&self, now: DateTime<Utc>) -> bool {
        match self {
            PolledRequest::Device(device_request) => device_request.is_pending_at(now),
            PolledRequest::Pairing(pairing_request) => pairing_request.is_pending_at(now),
        }
    }
}

impl From<PolledRequest> for super::AuthorizationRequest {
    fn from(polled_request: PolledRequest) -> Self {
        match polled_request {
            PolledRequest::Device(device_request) => {
                super::AuthorizationRequest::Device(device_request)
            }
            PolledRequest::Pairing(pairing_request) => {
                super::AuthorizationRequest::Pairing(pairing_request)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use chrono::Duration;

    use super::*;
    use crate::domain::authorization_request::approval::Approval;
    use crate::domain::authorization_request::device::NewDeviceRequestArgs;

    fn at(seconds: i64) -> DateTime<Utc> {
        DateTime::from_timestamp(1_800_000_000, 0).expect("in range") + Duration::seconds(seconds)
    }

    /// A device request started at second 0, live for five minutes.
    fn device_request() -> DeviceRequest {
        DeviceRequest::new(
            NewDeviceRequestArgs {
                id: "dev-1".to_owned(),
                client_id: "app".to_owned(),
                requested_scopes: vec!["openid".to_owned()],
                ttl: Duration::minutes(5),
                user_code: "WILD-FLWR".to_owned(),
                device_name: None,
            },
            at(0),
        )
    }

    fn approval() -> Approval {
        Approval {
            granted_scopes: vec!["openid".to_owned()],
            patient: Some("Patient/1".to_owned()),
        }
    }

    /// The slow-down holds for the poll interval after the last poll, and not
    /// before the first poll.
    #[test]
    fn a_poll_within_the_interval_of_the_last_one_is_too_soon() {
        let request = device_request();
        assert!(!request.is_polled_too_soon_at(at(0)));
        let stamped = request.stamp_poll(at(10)).expect("stamps");
        assert!(stamped.is_polled_too_soon_at(at(14)));
        assert!(!stamped.is_polled_too_soon_at(at(15)));
    }

    /// An approved, unexpired request is claimed once, keeping its approval;
    /// a pending one, a claimed one and an expired one are not claimable.
    #[test]
    fn claim_redeems_an_approved_request_once() {
        let request = device_request();
        let approved = request.approve(approval(), None, at(1)).expect("approves");
        let claimed = approved.claim(at(2)).expect("claims");
        assert_eq!(claimed.state, PolledState::Claimed(approval()));
        assert_eq!(claimed.state.status(), RequestStatus::Claimed);
        assert_eq!(claimed.state.approval(), Some(&approval()));
        assert_eq!(claimed.claim(at(2)), Err(NotClaimable));
        assert_eq!(request.claim(at(2)), Err(NotClaimable));
        assert_eq!(approved.claim(at(300)), Err(NotClaimable));
    }
}
