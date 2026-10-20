//! [`CodeRequest`] — an RFC 6749 §4.1.1 authorization request, parked by
//! `/oauth/authorize` until the Owner (or the browser that made it) decides
//! it. A request asking for more than its browser's session holds first waits
//! on that browser's limited page
//! ([`AwaitingLimitedPage`](CodeRequestState::AwaitingLimitedPage)), and the
//! Owner is asked about it only once the browser goes on. `resolved` judges
//! a request against its client's registration.

pub(crate) mod resolved;

use chrono::{DateTime, Duration, Utc};
use url::Url;

use super::approval::Approval;
use super::{NotPending, RequestStatus};

/// An authorization-code request, from `/oauth/authorize` to its decision.
/// Started by [`new`](Self::new) and changed only by its transitions, each of
/// which answers with the changed request for the store's guarded replace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodeRequest {
    /// An internal UUID: the `$id` of the wait page, the consent card and the
    /// limited page.
    pub id: String,
    /// The client that made the request.
    pub client_id: String,
    /// The scopes the client asked for.
    pub requested_scopes: Vec<String>,
    /// When the request started.
    pub requested_at: DateTime<Utc>,
    /// The instant the request stops waiting for a decision. Going on past
    /// the limited page restarts it.
    pub expires_at: DateTime<Utc>,
    /// Where the request stands.
    pub state: CodeRequestState,
    /// The redirect the client presented; its code or error goes back there.
    pub redirect_uri: Url,
    /// The PKCE S256 challenge (RFC 7636); `plain` is refused at the
    /// boundary, so the method is always S256.
    pub code_challenge: String,
    /// The `state` the client sent, which its callback carries back.
    pub client_state: String,
    /// The browser session the request was made in, which the code it earns
    /// is issued under: this session, not the approver's. `/oauth/authorize`
    /// sends a browser without one to pairing first.
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
}

/// Where a code request stands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CodeRequestState {
    /// Its browser's session holds less than it asks for, and that browser
    /// hasn't said to go on: it waits on the browser's limited page. The
    /// Owner isn't asked about it, and nothing decides it.
    AwaitingLimitedPage,
    /// Waiting for the Owner's decision, until it expires.
    Pending,
    /// The Owner, or a standing grant, approved it, and its code was issued.
    Approved(Approval),
    /// The Owner, or the browser that made it, declined it.
    Denied,
}

impl CodeRequestState {
    /// The state as stored, without its approval.
    #[must_use]
    pub fn status(&self) -> RequestStatus {
        match self {
            CodeRequestState::AwaitingLimitedPage => RequestStatus::AwaitingLimitedPage,
            CodeRequestState::Pending => RequestStatus::Pending,
            CodeRequestState::Approved(_) => RequestStatus::Approved,
            CodeRequestState::Denied => RequestStatus::Denied,
        }
    }

    /// The approval the request carries: present exactly when it is approved.
    #[must_use]
    pub fn approval(&self) -> Option<&Approval> {
        match self {
            CodeRequestState::Approved(approval) => Some(approval),
            CodeRequestState::AwaitingLimitedPage
            | CodeRequestState::Pending
            | CodeRequestState::Denied => None,
        }
    }
}

/// How a code request starts: its key, its client, what it asks for and how
/// long it waits, what the client presented, the launch it consumed, and
/// whether it waits on its browser's limited page first.
pub struct NewCodeRequestArgs {
    /// The request's internal UUID.
    pub id: String,
    /// The client that makes the request.
    pub client_id: String,
    /// The scopes the client asks for.
    pub requested_scopes: Vec<String>,
    /// How long the request waits for a decision.
    pub ttl: Duration,
    /// The redirect the client presented.
    pub redirect_uri: Url,
    /// The PKCE S256 challenge.
    pub code_challenge: String,
    /// The client's `state`.
    pub client_state: String,
    /// The browser session the request is made in.
    pub sid: String,
    /// The SMART App Launch `launch` the request consumed, if any.
    pub launch: Option<String>,
    /// The patient that launch binds, if any.
    pub launch_bound_patient: Option<String>,
    /// The requested scopes a standing grant already covers.
    pub pre_approved_scopes: Vec<String>,
    /// Whether the request can be decided in the browser that makes it.
    pub decidable_in_requesting_browser: bool,
    /// Whether the request waits on its browser's limited page first: its
    /// browser's session holds less than it asks for, and hasn't gone on for
    /// this client before.
    pub awaits_limited_page: bool,
}

/// A limited-page transition refused: the request isn't waiting on its
/// browser's limited page at `now` (its browser went on, it was decided, or
/// it expired).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NotAwaitingLimitedPage;

impl CodeRequest {
    /// A request started at `now`, expiring `ttl` later: waiting on its
    /// browser's limited page when
    /// [`awaits_limited_page`](NewCodeRequestArgs::awaits_limited_page),
    /// otherwise pending.
    #[must_use]
    pub fn new(args: NewCodeRequestArgs, now: DateTime<Utc>) -> Self {
        let NewCodeRequestArgs {
            id,
            client_id,
            requested_scopes,
            ttl,
            redirect_uri,
            code_challenge,
            client_state,
            sid,
            launch,
            launch_bound_patient,
            pre_approved_scopes,
            decidable_in_requesting_browser,
            awaits_limited_page,
        } = args;
        CodeRequest {
            id,
            client_id,
            requested_scopes,
            requested_at: now,
            expires_at: now + ttl,
            state: if awaits_limited_page {
                CodeRequestState::AwaitingLimitedPage
            } else {
                CodeRequestState::Pending
            },
            redirect_uri,
            code_challenge,
            client_state,
            sid,
            launch,
            launch_bound_patient,
            pre_approved_scopes,
            decidable_in_requesting_browser,
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
        self.state == CodeRequestState::Pending && !self.is_expired_at(now)
    }

    /// Whether the request waits on its browser's limited page at `now`, and
    /// is unexpired.
    #[must_use]
    pub fn is_awaiting_limited_page_at(&self, now: DateTime<Utc>) -> bool {
        self.state == CodeRequestState::AwaitingLimitedPage && !self.is_expired_at(now)
    }

    /// Whether an approval may bind `patient` to this request: any patient (or
    /// none) when its launch bound no patient, otherwise exactly the launch's.
    #[must_use]
    pub fn admits_patient(&self, patient: Option<&str>) -> bool {
        match self.launch_bound_patient.as_deref() {
            None => true,
            Some(launch_bound_patient) => patient == Some(launch_bound_patient),
        }
    }

    /// Approve the request at `now` with `approval`.
    ///
    /// # Errors
    ///
    /// [`NotPending`] for a request not pending at `now`.
    pub fn approve(&self, approval: Approval, now: DateTime<Utc>) -> Result<Self, NotPending> {
        self.require_pending(now)?;
        Ok(CodeRequest {
            state: CodeRequestState::Approved(approval),
            ..self.clone()
        })
    }

    /// Deny the request at `now`.
    ///
    /// # Errors
    ///
    /// [`NotPending`] for a request not pending at `now`.
    pub fn deny(&self, now: DateTime<Utc>) -> Result<Self, NotPending> {
        self.require_pending(now)?;
        Ok(CodeRequest {
            state: CodeRequestState::Denied,
            ..self.clone()
        })
    }

    /// Raise the request for the Owner at `now`: it stops being decidable in
    /// the browser that made it, so the host notifies for it. Decides
    /// nothing.
    ///
    /// # Errors
    ///
    /// [`NotPending`] for a request not pending at `now`.
    pub fn raise_for_owner(&self, now: DateTime<Utc>) -> Result<Self, NotPending> {
        self.require_pending(now)?;
        Ok(CodeRequest {
            decidable_in_requesting_browser: false,
            ..self.clone()
        })
    }

    /// Go on past the limited page at `now`: the browser that made the
    /// request says to go on although its session holds less than the
    /// request asks for. The request becomes pending, with `ttl` more from
    /// `now`. Decides nothing.
    ///
    /// # Errors
    ///
    /// [`NotAwaitingLimitedPage`] for a request not waiting there at `now`.
    pub fn acknowledge_session_shortfall(
        &self,
        ttl: Duration,
        now: DateTime<Utc>,
    ) -> Result<Self, NotAwaitingLimitedPage> {
        self.require_awaiting_limited_page(now)?;
        Ok(CodeRequest {
            state: CodeRequestState::Pending,
            expires_at: now + ttl,
            ..self.clone()
        })
    }

    /// Deny the request at `now` while it waits on its browser's limited
    /// page: the page's Cancel, or a client disabled before the browser went
    /// on.
    ///
    /// # Errors
    ///
    /// [`NotAwaitingLimitedPage`] for a request not waiting there at `now`.
    pub fn deny_on_limited_page(&self, now: DateTime<Utc>) -> Result<Self, NotAwaitingLimitedPage> {
        self.require_awaiting_limited_page(now)?;
        Ok(CodeRequest {
            state: CodeRequestState::Denied,
            ..self.clone()
        })
    }

    /// Refuse a transition on a request not pending at `now`.
    fn require_pending(&self, now: DateTime<Utc>) -> Result<(), NotPending> {
        if self.is_pending_at(now) {
            Ok(())
        } else {
            Err(NotPending)
        }
    }

    /// Refuse a limited-page transition on a request not waiting there at
    /// `now`.
    fn require_awaiting_limited_page(
        &self,
        now: DateTime<Utc>,
    ) -> Result<(), NotAwaitingLimitedPage> {
        if self.is_awaiting_limited_page_at(now) {
            Ok(())
        } else {
            Err(NotAwaitingLimitedPage)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::test_fake::fixture_code_args;

    /// The instant `minutes` after the tests' fixed start.
    fn at(minutes: i64) -> DateTime<Utc> {
        DateTime::from_timestamp(1_800_000_000, 0).expect("in range") + Duration::minutes(minutes)
    }

    /// A request started at minute 0, live until minute 5, on its limited
    /// page or pending.
    fn started(awaits_limited_page: bool) -> CodeRequest {
        CodeRequest::new(
            NewCodeRequestArgs {
                awaits_limited_page,
                ..fixture_code_args("req-1", "app", vec!["openid".to_owned()])
            },
            at(0),
        )
    }

    /// An approval of `openid` binding `Patient/1`.
    fn approval() -> Approval {
        Approval {
            granted_scopes: vec!["openid".to_owned()],
            patient: Some("Patient/1".to_owned()),
        }
    }

    /// A new request is pending, or on its limited page, until its expiry.
    #[test]
    fn a_new_request_starts_pending_or_on_its_limited_page() {
        let pending = started(false);
        assert_eq!(pending.state, CodeRequestState::Pending);
        assert_eq!(pending.expires_at, at(5));
        assert!(pending.is_pending_at(at(4)));
        assert!(!pending.is_pending_at(at(5)));
        let waiting = started(true);
        assert_eq!(waiting.state, CodeRequestState::AwaitingLimitedPage);
        assert!(waiting.is_awaiting_limited_page_at(at(4)));
        assert!(!waiting.is_pending_at(at(4)));
        assert!(!waiting.is_awaiting_limited_page_at(at(5)));
    }

    /// Approving records the approval; past expiry, once decided, or while
    /// on the limited page, it is refused.
    #[test]
    fn approve_records_the_approval_only_while_pending() {
        let request = started(false);
        let approved = request.approve(approval(), at(1)).expect("approves");
        assert_eq!(approved.state, CodeRequestState::Approved(approval()));
        assert_eq!(approved.state.approval(), Some(&approval()));
        assert_eq!(approved.state.status(), RequestStatus::Approved);
        assert_eq!(request.approve(approval(), at(5)), Err(NotPending));
        assert_eq!(approved.approve(approval(), at(1)), Err(NotPending));
        assert_eq!(started(true).approve(approval(), at(1)), Err(NotPending));
    }

    /// Denying a pending request decides it, with no approval.
    #[test]
    fn deny_decides_a_pending_request() {
        let denied = started(false).deny(at(1)).expect("denies");
        assert_eq!(denied.state, CodeRequestState::Denied);
        assert_eq!(denied.state.approval(), None);
        assert_eq!(denied.deny(at(1)), Err(NotPending));
        assert_eq!(started(true).deny(at(1)), Err(NotPending));
    }

    /// Raising the request for the Owner clears only whether it is decidable
    /// in the requesting browser.
    #[test]
    fn raise_for_owner_stops_the_request_counting_as_decidable_where_it_was_made() {
        let decidable = CodeRequest {
            decidable_in_requesting_browser: true,
            ..started(false)
        };
        let raised = decidable.raise_for_owner(at(1)).expect("raises");
        assert_eq!(
            raised,
            CodeRequest {
                decidable_in_requesting_browser: false,
                ..decidable
            }
        );
        assert_eq!(started(true).raise_for_owner(at(1)), Err(NotPending));
    }

    /// Going on past the limited page makes the request pending and restarts
    /// its expiry; it applies once, and only while the request waits there.
    #[test]
    fn acknowledge_session_shortfall_goes_on_past_the_limited_page_once() {
        let waiting = started(true);
        let continued = waiting
            .acknowledge_session_shortfall(Duration::minutes(5), at(3))
            .expect("goes on");
        assert_eq!(continued.state, CodeRequestState::Pending);
        assert_eq!(continued.expires_at, at(8));
        assert_eq!(
            continued.acknowledge_session_shortfall(Duration::minutes(5), at(4)),
            Err(NotAwaitingLimitedPage)
        );
        assert_eq!(
            waiting.acknowledge_session_shortfall(Duration::minutes(5), at(5)),
            Err(NotAwaitingLimitedPage)
        );
    }

    /// Denying on the limited page applies only while the request waits
    /// there.
    #[test]
    fn deny_on_limited_page_applies_only_while_the_request_waits_there() {
        let cancelled = started(true).deny_on_limited_page(at(1)).expect("cancels");
        assert_eq!(cancelled.state, CodeRequestState::Denied);
        assert_eq!(
            started(false).deny_on_limited_page(at(1)),
            Err(NotAwaitingLimitedPage)
        );
        assert_eq!(
            started(true).deny_on_limited_page(at(5)),
            Err(NotAwaitingLimitedPage)
        );
    }

    /// An approval names any patient when the launch bound none, and only
    /// the launch's patient otherwise.
    #[test]
    fn admits_patient_holds_an_approval_to_the_launch_s_patient() {
        let unbound = started(false);
        assert!(unbound.admits_patient(None));
        assert!(unbound.admits_patient(Some("Patient/2")));
        let bound = CodeRequest {
            launch_bound_patient: Some("Patient/1".to_owned()),
            ..started(false)
        };
        assert!(bound.admits_patient(Some("Patient/1")));
        assert!(!bound.admits_patient(Some("Patient/2")));
        assert!(!bound.admits_patient(None));
    }
}
