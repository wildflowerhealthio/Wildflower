//! [`DeviceRequest`] — an RFC 8628 §3.1 device authorization request: a
//! device asks for a token, shows its user a `user_code`, and polls
//! `/oauth/token` with its `device_code` until the Owner decides at the
//! device page.

use chrono::{DateTime, Duration, Utc};

use super::approval::Approval;
use super::polled::{claimed_state, NotClaimable, Polled, PolledState};
use super::NotPending;

/// An RFC 8628 device authorization request, from its start to the poll that
/// claims the Owner's approval. Started by [`new`](Self::new) and changed only
/// by its transitions, each of which answers with the changed request for the
/// store's guarded replace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceRequest {
    /// The `device_code` the device polls with: a 256-bit secret only the
    /// device holds.
    pub id: String,
    /// The device's client.
    pub client_id: String,
    /// The scopes the device asked for.
    pub requested_scopes: Vec<String>,
    /// When the request started.
    pub requested_at: DateTime<Utc>,
    /// The instant the request stops waiting for a decision.
    pub expires_at: DateTime<Utc>,
    /// The code the device shows its user, which the Owner enters at the
    /// device page.
    pub user_code: String,
    /// The name the device gave itself (an RFC 8628 extension), or the one
    /// the approver settled on; `None` falls back to the client's name.
    pub device_name: Option<String>,
    /// The device's last `/oauth/token` poll, for the §3.5 slow-down.
    pub last_polled_at: Option<DateTime<Utc>>,
    /// Where the request stands.
    pub state: PolledState<Approval>,
}

/// How a device request starts: its key, its client, what it asks for, how
/// long it waits for a decision, and the device's codes and name.
pub struct NewDeviceRequestArgs {
    /// The `device_code`.
    pub id: String,
    /// The device's client.
    pub client_id: String,
    /// The scopes the device asks for.
    pub requested_scopes: Vec<String>,
    /// How long the request waits for a decision.
    pub ttl: Duration,
    /// The code the device shows its user.
    pub user_code: String,
    /// The name the device gives itself, if any.
    pub device_name: Option<String>,
}

impl DeviceRequest {
    /// A pending device request started at `now`, expiring `ttl` later.
    #[must_use]
    pub fn new(args: NewDeviceRequestArgs, now: DateTime<Utc>) -> Self {
        let NewDeviceRequestArgs {
            id,
            client_id,
            requested_scopes,
            ttl,
            user_code,
            device_name,
        } = args;
        DeviceRequest {
            id,
            client_id,
            requested_scopes,
            requested_at: now,
            expires_at: now + ttl,
            user_code,
            device_name,
            last_polled_at: None,
            state: PolledState::Pending,
        }
    }

    /// Approve the request at `now` with `approval`, naming the device
    /// `device_name` (`None` keeps the name it has).
    ///
    /// # Errors
    ///
    /// [`NotPending`] for a request no longer pending at `now`.
    pub fn approve(
        &self,
        approval: Approval,
        device_name: Option<String>,
        now: DateTime<Utc>,
    ) -> Result<Self, NotPending> {
        self.require_pending(now)?;
        Ok(DeviceRequest {
            device_name: device_name.or_else(|| self.device_name.clone()),
            state: PolledState::Approved(approval),
            ..self.clone()
        })
    }

    /// Deny the request at `now`.
    ///
    /// # Errors
    ///
    /// [`NotPending`] for a request no longer pending at `now`.
    pub fn deny(&self, now: DateTime<Utc>) -> Result<Self, NotPending> {
        self.require_pending(now)?;
        Ok(DeviceRequest {
            state: PolledState::Denied,
            ..self.clone()
        })
    }

    /// Stamp the pending request's poll at `now`, for the next poll's
    /// slow-down.
    ///
    /// # Errors
    ///
    /// [`NotPending`] for a request no longer pending at `now`.
    pub fn stamp_poll(&self, now: DateTime<Utc>) -> Result<Self, NotPending> {
        self.require_pending(now)?;
        Ok(DeviceRequest {
            last_polled_at: Some(now),
            ..self.clone()
        })
    }

    /// Refuse a transition on a request no longer pending at `now`.
    fn require_pending(&self, now: DateTime<Utc>) -> Result<(), NotPending> {
        if self.is_pending_at(now) {
            Ok(())
        } else {
            Err(NotPending)
        }
    }
}

impl Polled for DeviceRequest {
    type Approval = Approval;

    fn user_code(&self) -> &str {
        &self.user_code
    }

    fn last_polled_at(&self) -> Option<DateTime<Utc>> {
        self.last_polled_at
    }

    fn expires_at(&self) -> DateTime<Utc> {
        self.expires_at
    }

    fn state(&self) -> &PolledState<Approval> {
        &self.state
    }

    fn claim(&self, now: DateTime<Utc>) -> Result<Self, NotClaimable> {
        Ok(DeviceRequest {
            state: claimed_state(self, now)?,
            ..self.clone()
        })
    }
}

/// The name a device grant is keyed on: the device name recorded on the
/// request, or the client's own name when it has none. The approval records the
/// grant under it and the token poll looks the grant up by it, so both go
/// through here.
#[must_use]
pub fn device_grant_name<'a>(
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

    /// A device request started at minute 0, pending until minute 5.
    fn started() -> DeviceRequest {
        DeviceRequest::new(
            NewDeviceRequestArgs {
                id: "dev-1".to_owned(),
                client_id: "app".to_owned(),
                requested_scopes: vec!["openid".to_owned()],
                ttl: Duration::minutes(5),
                user_code: "WILD-FLWR".to_owned(),
                device_name: Some("Kitchen iPad".to_owned()),
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

    /// A new request is pending until its expiry, and expired from it on.
    #[test]
    fn a_new_request_is_pending_until_it_expires() {
        let request = started();
        assert_eq!(request.requested_at, at(0));
        assert_eq!(request.expires_at, at(5));
        assert_eq!(request.state, PolledState::Pending);
        assert!(request.is_pending_at(at(4)));
        assert!(request.is_expired_at(at(5)));
        assert!(!request.is_pending_at(at(5)));
    }

    /// Approving records the approval and the device's settled name; `None`
    /// keeps the name it has; once decided, or past expiry, it is refused.
    #[test]
    fn approve_records_the_approval_and_the_device_s_name() {
        let request = started();
        let renamed = request
            .approve(approval(), Some("Reception iPad".to_owned()), at(1))
            .expect("approves");
        assert_eq!(renamed.state, PolledState::Approved(approval()));
        assert_eq!(renamed.device_name.as_deref(), Some("Reception iPad"));
        let kept_name = request.approve(approval(), None, at(1)).expect("approves");
        assert_eq!(kept_name.device_name.as_deref(), Some("Kitchen iPad"));
        assert_eq!(renamed.approve(approval(), None, at(1)), Err(NotPending));
        assert_eq!(request.approve(approval(), None, at(5)), Err(NotPending));
    }

    /// Denying a pending request decides it, with no approval.
    #[test]
    fn deny_decides_a_pending_request() {
        let denied = started().deny(at(1)).expect("denies");
        assert_eq!(denied.state, PolledState::Denied);
        assert_eq!(denied.deny(at(1)), Err(NotPending));
    }

    /// A poll stamp records the poll and leaves the state as it was.
    #[test]
    fn stamp_poll_records_the_poll() {
        let stamped = started().stamp_poll(at(1)).expect("stamps");
        assert_eq!(stamped.last_polled_at, Some(at(1)));
        assert_eq!(stamped.state, PolledState::Pending);
        assert_eq!(started().stamp_poll(at(5)), Err(NotPending));
    }

    /// The grant is keyed on the request's device name, or the client's.
    #[test]
    fn the_grant_name_falls_back_to_the_client_s_name() {
        assert_eq!(device_grant_name(Some("iPad"), "App"), "iPad");
        assert_eq!(device_grant_name(None, "App"), "App");
    }
}
