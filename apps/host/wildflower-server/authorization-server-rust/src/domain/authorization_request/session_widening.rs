//! [`SessionWideningRequest`] — a browser asking the Owner to widen its own
//! browser session. Filed from the limited page of a code request whose
//! session holds less than the app asked for, it names what the session lacks
//! of that request. The Owner decides it on its own consent card, and may
//! untick scopes. An approval widens the session (same `sid`, same expiry)
//! by what the Owner granted; the limited page's poll then claims it, once,
//! to take a session token carrying the wider scopes. Widening is no OAuth
//! grant: it records no grant and no client registration.

use chrono::{DateTime, Duration, Utc};

use super::polled::{NotClaimable, PolledState};
use super::NotPending;

/// What the Owner approved for a session widening: the scopes the session
/// gains.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionWideningApproval {
    /// The scopes the Owner granted, which the session now also holds.
    pub granted_scopes: Vec<String>,
}

/// A session widening, from the limited page's ask to the poll that claims
/// the Owner's approval. Started by [`new`](Self::new) and changed only by
/// its transitions, each of which answers with the changed request for the
/// store's guarded replace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionWideningRequest {
    /// An internal UUID: the `$id` of the widening's consent card and of the
    /// limited page's poll.
    pub id: String,
    /// The browser session to widen: the one the asking browser holds.
    pub sid: String,
    /// The app whose request the session fell short of, named on the
    /// Owner's card.
    pub client_id: String,
    /// The name the browser went by when it asked: its session's name.
    pub browser_name: String,
    /// The scopes the session lacks of the app's request: the most the
    /// Owner may grant.
    pub requested_scopes: Vec<String>,
    /// When the browser asked.
    pub requested_at: DateTime<Utc>,
    /// The instant the request stops waiting for a decision, and its
    /// approval stops being claimable.
    pub expires_at: DateTime<Utc>,
    /// Where the request stands.
    pub state: PolledState<SessionWideningApproval>,
}

/// How a session widening starts: its key, the session and the app, what it
/// asks for, and how long it waits for a decision.
pub struct NewSessionWideningRequestArgs {
    /// The request's internal UUID.
    pub id: String,
    /// The browser session to widen.
    pub sid: String,
    /// The app whose request the session fell short of.
    pub client_id: String,
    /// The browser session's name.
    pub browser_name: String,
    /// The scopes the session lacks of the app's request.
    pub requested_scopes: Vec<String>,
    /// How long the request waits for a decision.
    pub ttl: Duration,
}

impl SessionWideningRequest {
    /// A pending widening started at `now`, expiring `ttl` later.
    #[must_use]
    pub fn new(args: NewSessionWideningRequestArgs, now: DateTime<Utc>) -> Self {
        let NewSessionWideningRequestArgs {
            id,
            sid,
            client_id,
            browser_name,
            requested_scopes,
            ttl,
        } = args;
        SessionWideningRequest {
            id,
            sid,
            client_id,
            browser_name,
            requested_scopes,
            requested_at: now,
            expires_at: now + ttl,
            state: PolledState::Pending,
        }
    }

    /// Whether the request is past its expiry at `now`.
    #[must_use]
    pub fn is_expired_at(&self, now: DateTime<Utc>) -> bool {
        self.expires_at <= now
    }

    /// Whether the request waits for the Owner's decision at `now`: pending
    /// and unexpired.
    #[must_use]
    pub fn is_pending_at(&self, now: DateTime<Utc>) -> bool {
        self.state == PolledState::Pending && !self.is_expired_at(now)
    }

    /// Approve the widening at `now` with `approval`.
    ///
    /// # Errors
    ///
    /// [`NotPending`] for a widening no longer pending at `now`.
    pub fn approve(
        &self,
        approval: SessionWideningApproval,
        now: DateTime<Utc>,
    ) -> Result<Self, NotPending> {
        self.require_pending(now)?;
        Ok(SessionWideningRequest {
            state: PolledState::Approved(approval),
            ..self.clone()
        })
    }

    /// Deny the widening at `now`.
    ///
    /// # Errors
    ///
    /// [`NotPending`] for a widening no longer pending at `now`.
    pub fn deny(&self, now: DateTime<Utc>) -> Result<Self, NotPending> {
        self.require_pending(now)?;
        Ok(SessionWideningRequest {
            state: PolledState::Denied,
            ..self.clone()
        })
    }

    /// Claim the approved widening at `now`, once: the limited page's poll
    /// taking the wider session token.
    ///
    /// # Errors
    ///
    /// [`NotClaimable`] for a widening not approved, or past its expiry.
    pub fn claim(&self, now: DateTime<Utc>) -> Result<Self, NotClaimable> {
        match &self.state {
            PolledState::Approved(approval) if !self.is_expired_at(now) => {
                Ok(SessionWideningRequest {
                    state: PolledState::Claimed(approval.clone()),
                    ..self.clone()
                })
            }
            _ => Err(NotClaimable),
        }
    }

    /// Refuse a transition on a widening no longer pending at `now`.
    fn require_pending(&self, now: DateTime<Utc>) -> Result<(), NotPending> {
        if self.is_pending_at(now) {
            Ok(())
        } else {
            Err(NotPending)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The instant `minutes` after the tests' fixed start.
    fn at(minutes: i64) -> DateTime<Utc> {
        DateTime::from_timestamp(1_800_000_000, 0).expect("in range") + Duration::minutes(minutes)
    }

    /// A widening started at minute 0, pending until minute 5.
    fn started() -> SessionWideningRequest {
        SessionWideningRequest::new(
            NewSessionWideningRequestArgs {
                id: "widen-1".to_owned(),
                sid: "sid-1".to_owned(),
                client_id: "app".to_owned(),
                browser_name: "Firefox on Linux".to_owned(),
                requested_scopes: vec!["wildflower/Apps.r".to_owned()],
                ttl: Duration::minutes(5),
            },
            at(0),
        )
    }

    /// An approval of `wildflower/Apps.r`.
    fn approval() -> SessionWideningApproval {
        SessionWideningApproval {
            granted_scopes: vec!["wildflower/Apps.r".to_owned()],
        }
    }

    /// A pending widening is approved or denied once, and not after it
    /// expires.
    #[test]
    fn a_pending_widening_is_decided_once_until_it_expires() {
        let approved = started().approve(approval(), at(1)).expect("approves");
        assert_eq!(approved.state, PolledState::Approved(approval()));
        assert_eq!(approved.deny(at(1)), Err(NotPending));
        let denied = started().deny(at(1)).expect("denies");
        assert_eq!(denied.state, PolledState::Denied);
        assert_eq!(denied.approve(approval(), at(1)), Err(NotPending));
        assert_eq!(started().approve(approval(), at(5)), Err(NotPending));
    }

    /// An approved, unexpired widening is claimed once, keeping its
    /// approval; a pending, denied or expired one is not claimable.
    #[test]
    fn claim_redeems_an_approved_widening_once() {
        let approved = started().approve(approval(), at(1)).expect("approves");
        let claimed = approved.claim(at(2)).expect("claims");
        assert_eq!(claimed.state, PolledState::Claimed(approval()));
        assert_eq!(claimed.claim(at(2)), Err(NotClaimable));
        assert_eq!(started().claim(at(2)), Err(NotClaimable));
        assert_eq!(
            started().deny(at(1)).expect("denies").claim(at(2)),
            Err(NotClaimable)
        );
        assert_eq!(approved.claim(at(5)), Err(NotClaimable));
    }
}
