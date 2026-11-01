//! [`PairingRequest`] — a browser pairing: a browser that isn't on the
//! server's own device asks the Owner for a browser session at `/oauth/pair`,
//! shows a `user_code`, and polls with its pairing code until the Owner
//! decides at the device page. Pairing is no OAuth grant: the claim starts a
//! paired browser session, and nothing is redeemed at `/oauth/token`.

use chrono::{DateTime, Duration, Utc};

use super::polled::{claimed_state, NotClaimable, Polled, PolledState};
use super::NotPending;

/// What the Owner approved for a browser pairing: the scopes the paired
/// session holds. A browser session binds no patient.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairingApproval {
    /// The scopes the Owner granted, which the paired session holds.
    pub granted_scopes: Vec<String>,
}

/// A browser pairing, from its start to the poll that claims the Owner's
/// approval. Started by [`new`](Self::new) and changed only by its
/// transitions, each of which answers with the changed request for the
/// store's guarded replace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairingRequest {
    /// The pairing code the page polls with: a 256-bit secret only the page
    /// that started the pairing holds.
    pub id: String,
    /// The browser-session client, which every browser session's token is
    /// issued to.
    pub client_id: String,
    /// The scopes the pairing asks for: the Owner's.
    pub requested_scopes: Vec<String>,
    /// When the pairing started.
    pub requested_at: DateTime<Utc>,
    /// The instant the pairing stops waiting for a decision.
    pub expires_at: DateTime<Utc>,
    /// The code the pairing page shows, which the Owner confirms at the
    /// device page.
    pub user_code: String,
    /// The name the browser goes by on the Owner's card: one it gave itself,
    /// one taken from its user agent, or the one the approver settled on.
    pub browser_name: String,
    /// The pairing page's last poll, for the slow-down.
    pub last_polled_at: Option<DateTime<Utc>>,
    /// Where the pairing stands.
    pub state: PolledState<PairingApproval>,
}

/// How a pairing starts: its key, the browser-session client, what it asks
/// for, how long it waits for a decision, and the page's code and name.
pub struct NewPairingRequestArgs {
    /// The pairing code.
    pub id: String,
    /// The browser-session client.
    pub client_id: String,
    /// The scopes the pairing asks for.
    pub requested_scopes: Vec<String>,
    /// How long the pairing waits for a decision.
    pub ttl: Duration,
    /// The code the page shows.
    pub user_code: String,
    /// The name the browser goes by until it names itself.
    pub browser_name: String,
}

impl PairingRequest {
    /// A pending pairing started at `now`, expiring `ttl` later.
    #[must_use]
    pub fn new(args: NewPairingRequestArgs, now: DateTime<Utc>) -> Self {
        let NewPairingRequestArgs {
            id,
            client_id,
            requested_scopes,
            ttl,
            user_code,
            browser_name,
        } = args;
        PairingRequest {
            id,
            client_id,
            requested_scopes,
            requested_at: now,
            expires_at: now + ttl,
            user_code,
            browser_name,
            last_polled_at: None,
            state: PolledState::Pending,
        }
    }

    /// The pairing as it would be once approved at `now` with `approval`,
    /// naming the browser `browser_name` (`None` keeps the name it has).
    /// Stores nothing.
    ///
    /// # Errors
    ///
    /// [`NotPending`] for a pairing no longer pending at `now`.
    pub fn to_approved(
        &self,
        approval: PairingApproval,
        browser_name: Option<String>,
        now: DateTime<Utc>,
    ) -> Result<Self, NotPending> {
        self.require_pending(now)?;
        Ok(PairingRequest {
            browser_name: browser_name.unwrap_or_else(|| self.browser_name.clone()),
            state: PolledState::Approved(approval),
            ..self.clone()
        })
    }

    /// The pairing as it would be once denied at `now`. Stores nothing.
    ///
    /// # Errors
    ///
    /// [`NotPending`] for a pairing no longer pending at `now`.
    pub fn to_denied(&self, now: DateTime<Utc>) -> Result<Self, NotPending> {
        self.require_pending(now)?;
        Ok(PairingRequest {
            state: PolledState::Denied,
            ..self.clone()
        })
    }

    /// Stamp the pending pairing's poll at `now`, for the next poll's
    /// slow-down, and record the `browser_name` its page now gives.
    ///
    /// # Errors
    ///
    /// [`NotPending`] for a pairing no longer pending at `now`.
    pub fn to_poll_stamped(
        &self,
        browser_name: &str,
        now: DateTime<Utc>,
    ) -> Result<Self, NotPending> {
        self.require_pending(now)?;
        Ok(PairingRequest {
            browser_name: browser_name.to_owned(),
            last_polled_at: Some(now),
            ..self.clone()
        })
    }

    /// Refuse a transition on a pairing no longer pending at `now`.
    fn require_pending(&self, now: DateTime<Utc>) -> Result<(), NotPending> {
        if self.is_pending_at(now) {
            Ok(())
        } else {
            Err(NotPending)
        }
    }
}

impl Polled for PairingRequest {
    type Approval = PairingApproval;

    fn user_code(&self) -> &str {
        &self.user_code
    }

    fn last_polled_at(&self) -> Option<DateTime<Utc>> {
        self.last_polled_at
    }

    fn expires_at(&self) -> DateTime<Utc> {
        self.expires_at
    }

    fn state(&self) -> &PolledState<PairingApproval> {
        &self.state
    }

    fn to_claimed(&self, now: DateTime<Utc>) -> Result<Self, NotClaimable> {
        Ok(PairingRequest {
            state: claimed_state(self, now)?,
            ..self.clone()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The instant `minutes` after the tests' fixed start.
    fn at(minutes: i64) -> DateTime<Utc> {
        DateTime::from_timestamp(1_800_000_000, 0).expect("in range") + Duration::minutes(minutes)
    }

    /// A pairing started at minute 0, pending until minute 5.
    fn started() -> PairingRequest {
        PairingRequest::new(
            NewPairingRequestArgs {
                id: "pair-1".to_owned(),
                client_id: "browser-session".to_owned(),
                requested_scopes: vec!["wildflower/launch".to_owned()],
                ttl: Duration::minutes(5),
                user_code: "PAIR-CODE".to_owned(),
                browser_name: "Firefox on Linux".to_owned(),
            },
            at(0),
        )
    }

    /// An approval of `wildflower/launch`.
    fn approval() -> PairingApproval {
        PairingApproval {
            granted_scopes: vec!["wildflower/launch".to_owned()],
        }
    }

    /// Approving records the approval and the browser's settled name; `None`
    /// keeps the name it has.
    #[test]
    fn to_approved_records_the_approval_and_the_browser_s_name() {
        let request = started();
        let renamed = request
            .to_approved(approval(), Some("Ruth's laptop".to_owned()), at(1))
            .expect("approves");
        assert_eq!(renamed.state, PolledState::Approved(approval()));
        assert_eq!(renamed.browser_name, "Ruth's laptop");
        let kept_name = request
            .to_approved(approval(), None, at(1))
            .expect("approves");
        assert_eq!(kept_name.browser_name, "Firefox on Linux");
        assert_eq!(
            renamed.to_approved(approval(), None, at(1)),
            Err(NotPending)
        );
    }

    /// Denying a pending pairing decides it.
    #[test]
    fn to_denied_decides_a_pending_pairing() {
        let denied = started().to_denied(at(1)).expect("denies");
        assert_eq!(denied.state, PolledState::Denied);
        assert_eq!(denied.to_denied(at(2)), Err(NotPending));
    }

    /// A poll stamp records the poll and the browser's latest name, only
    /// while the pairing is pending.
    #[test]
    fn to_poll_stamped_records_the_poll_and_the_browser_s_name() {
        let stamped = started()
            .to_poll_stamped("Kitchen laptop", at(1))
            .expect("stamps");
        assert_eq!(stamped.browser_name, "Kitchen laptop");
        assert_eq!(stamped.last_polled_at, Some(at(1)));
        assert_eq!(stamped.state, PolledState::Pending);
        assert_eq!(
            started().to_poll_stamped("Kitchen laptop", at(5)),
            Err(NotPending)
        );
    }

    /// An approved pairing is claimed once, keeping its approval.
    #[test]
    fn to_claimed_redeems_an_approved_pairing_once() {
        let approved = started()
            .to_approved(approval(), None, at(1))
            .expect("approves");
        let claimed = approved.to_claimed(at(2)).expect("claims");
        assert_eq!(claimed.state, PolledState::Claimed(approval()));
        assert_eq!(claimed.to_claimed(at(3)), Err(NotClaimable));
    }
}
