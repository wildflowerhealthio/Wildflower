//! [`SessionWidening`] — the limited page's ask to widen the browser's own
//! session, and its poll for the Owner's decision. A browser whose session
//! holds less than an app's request asks for can ask the Owner, from that
//! request's limited page, to widen the session by what it lacks
//! ([`ask`](SessionWidening::ask)); the Owner decides it on its own consent
//! card (`ConsentDecider`), which widens the session's row on approval. The
//! page's poll ([`poll`](SessionWidening::poll)) then claims the approval
//! once, minting the browser a session token that carries the wider scopes
//! for the same session, and revoking the token it replaces.
//!
//! Both answer only the browser session the widening is for, read from its
//! cookie, so a leaked id asks and collects nothing. Re-pairing is not how a
//! session grows: it would end the session, and everything minted under it.

use std::sync::Arc;

use chrono::{DateTime, Duration, Utc};
use uuid::Uuid;
use wildflowerhealthio_scopes::Grant;

use super::code_authorization_starter::AUTHORIZATION_REQUEST_TTL;
use super::session_shortfall::load_code_request_awaiting_limited_page;
use crate::domain::access_token::{AccessTokenIssuanceError, VerifiedClaims};
use crate::domain::authority::{session_shortfall, ClaimedSessionWidening, TokenEntitlement};
use crate::domain::authorization_request::polled::PolledState;
use crate::domain::authorization_request::session_widening::{
    NewSessionWideningRequestArgs, SessionWideningRequest,
};
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::browser_session::{BrowserSessionKind, StaleSessionCutoff};
use crate::domain::capabilities::writers::AccessTokenMinter;
use crate::domain::grant_store::{AuthorizationRequestsTx as _, BrowserSessionsTx as _};
use crate::domain::{GrantStore, GrantTx};
use crate::ports::{OwnerApproval, Revocation};

/// What an [`ask`](SessionWidening::ask) came to.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SessionWideningAsk {
    /// A widening waits for the Owner — filed by this ask, or by an earlier
    /// one for the same session, app and scopes — and the page polls it.
    Asked {
        /// The widening's id.
        widening_id: String,
    },
    /// The authorization start limit refused a new widening; nothing was
    /// filed, and the code request waits as it did.
    StartLimited,
}

/// Where a widening stands, as one poll found it.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SessionWideningStatus {
    /// The Owner hasn't decided yet.
    Pending,
    /// The Owner declined: the session is as it was.
    Declined,
    /// The Owner approved, and this poll claimed it: the session holds more,
    /// and the browser holds this token for it now.
    Widened {
        /// The same session's token, carrying what it holds now, which the
        /// browser holds as its browser session cookie.
        session_token: String,
        /// How long the token lives: until the session ends.
        session_ttl: Duration,
    },
    /// The widening is past its expiry undecided, or an earlier poll claimed
    /// it, or its session has ended since: there is nothing more to collect.
    /// A session the Owner widened stays widened.
    Expired,
}

/// Why a poll answered nothing about the widening.
#[derive(Debug)]
pub(crate) enum SessionWideningPollError {
    /// The store couldn't be read or written, or no widening of this
    /// session's has the id
    /// ([`AuthorizationServerError::SessionWideningNotFound`]).
    Store(AuthorizationServerError),
    /// The widened session's token couldn't be minted (no signing key, or
    /// signing failed); the claim was rolled back with it.
    Issuance(AccessTokenIssuanceError),
}

impl From<AuthorizationServerError> for SessionWideningPollError {
    fn from(error: AuthorizationServerError) -> Self {
        SessionWideningPollError::Store(error)
    }
}

/// What a poll's scope did with a widening.
enum PolledWidening {
    /// The poll's answer needs nothing more.
    Answered(SessionWideningStatus),
    /// The approved widening was claimed and the session's new token minted.
    Claimed {
        /// The session's new token.
        session_token: String,
        /// How long it lives.
        session_ttl: Duration,
    },
}

/// Ask for, and poll, session widenings. Generic over the store port so it's
/// unit-testable against the fake; the binding instantiates it over the
/// concrete `SqliteGrantStore`.
pub(crate) struct SessionWidening<S: GrantStore> {
    /// The store an ask files the widening in, and a poll claims it in.
    store: S,
    /// Republishes the Owner prompt once an ask has committed, so the host
    /// notifies the Owner.
    owner_approval: Arc<dyn OwnerApproval>,
    /// The revocation store, where a claim denylists the token its new one
    /// replaces.
    revocation: Arc<dyn Revocation>,
    /// The server's bare origin, the session token's `iss` and `aud`.
    server_origin: Arc<str>,
    /// The cutoff before which a same-device session is stale: a widening
    /// is asked and claimed only for a session live under it.
    stale_session_cutoff: Arc<StaleSessionCutoff>,
}

impl<S: GrantStore> SessionWidening<S> {
    /// Build it over the handles lifted from the state.
    pub(crate) fn new(
        store: S,
        owner_approval: Arc<dyn OwnerApproval>,
        revocation: Arc<dyn Revocation>,
        server_origin: Arc<str>,
        stale_session_cutoff: Arc<StaleSessionCutoff>,
    ) -> Self {
        SessionWidening {
            store,
            owner_approval,
            revocation,
            server_origin,
            stale_session_cutoff,
        }
    }

    /// Ask the Owner to widen the browser session `sid` by what it lacks of
    /// the code request `code_request_id`, which waits on that browser's
    /// limited page. The widening asks for exactly the request's
    /// [`session_shortfall`] against the session as its row stands, never for
    /// anything the browser names. It waits for the Owner for
    /// [`AUTHORIZATION_REQUEST_TTL`], and the code request waits on its
    /// limited page until the widening's approval can no longer be collected
    /// and gone on with
    /// ([`asking_code_request_expires_at`](SessionWideningRequest::asking_code_request_expires_at)).
    ///
    /// Asking again while a widening of this session for the same app and
    /// the same scopes still waits for the Owner answers that widening: the
    /// Owner isn't told again, the start limit isn't asked, and the code
    /// request waits no longer than that widening lets it. Only a new
    /// widening asks `may_ask_owner` — the authorization start limit, which a
    /// widening spends from as any request raised for the Owner does — and
    /// republishes the Owner prompt once it commits.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::AuthorizationRequestNotFound`] when no
    /// request of this session's waits on its limited page with that id, as
    /// the page's other calls answer, or when there is nothing to ask for: a
    /// session that has ended, or holds all the request asks, or is the
    /// Owner's own same-device session (which holds all the Owner could
    /// grant). A store failure.
    pub(crate) fn ask(
        &self,
        code_request_id: &str,
        sid: &str,
        may_ask_owner: impl FnOnce() -> bool,
        now: DateTime<Utc>,
    ) -> Result<SessionWideningAsk, AuthorizationServerError> {
        let not_found = || AuthorizationServerError::AuthorizationRequestNotFound {
            id: code_request_id.to_owned(),
        };
        let asked = self.store.write(|tx| {
            let code_request =
                load_code_request_awaiting_limited_page(tx, code_request_id, sid, now)?;
            let browser_session = tx
                .browser_session_by_sid(sid)?
                .filter(|browser_session| {
                    browser_session.is_live_at(now, &self.stale_session_cutoff)
                })
                .filter(|browser_session| browser_session.kind == BrowserSessionKind::Paired)
                .ok_or_else(not_found)?;
            let Some(browser_name) = browser_session.name else {
                return Err(not_found());
            };
            let missing_scopes = session_shortfall(
                &code_request.requested_scopes,
                &Grant::parse(&browser_session.scopes),
            );
            if missing_scopes.is_empty() {
                return Err(not_found());
            }
            let already_asked = tx
                .pending_session_widening_requests_for_session(sid, now)?
                .into_iter()
                .find(|widening_request| {
                    widening_request.client_id == code_request.client_id
                        && widening_request.requested_scopes == missing_scopes
                });
            let (widening_request, filed) = match already_asked {
                Some(widening_request) => (widening_request, false),
                None if !may_ask_owner() => return Ok(None),
                None => {
                    let widening_request = SessionWideningRequest::new(
                        NewSessionWideningRequestArgs {
                            id: Uuid::new_v4().to_string(),
                            sid: sid.to_owned(),
                            client_id: code_request.client_id.clone(),
                            browser_name,
                            requested_scopes: missing_scopes,
                            ttl: AUTHORIZATION_REQUEST_TTL,
                        },
                        now,
                    );
                    tx.insert_session_widening_request(&widening_request)?;
                    (widening_request, true)
                }
            };
            let waiting_longer = code_request
                .extend_limited_page_wait_until(
                    widening_request.asking_code_request_expires_at(),
                    now,
                )
                .map_err(|_| not_found())?;
            if waiting_longer != code_request
                && !tx.replace_code_request(&code_request, &waiting_longer)?
            {
                return Err(not_found());
            }
            Ok(Some((widening_request.id, filed)))
        })?;
        let Some((widening_id, filed)) = asked else {
            return Ok(SessionWideningAsk::StartLimited);
        };
        if filed {
            self.owner_approval.republish_active();
        }
        Ok(SessionWideningAsk::Asked { widening_id })
    }

    /// Poll the widening `widening_id` at `now`, for the browser whose
    /// session cookie carries `presented_session`. The whole poll is one
    /// write scope:
    ///
    ///  - pending and unexpired: [`Pending`](SessionWideningStatus::Pending);
    ///  - denied: [`Declined`](SessionWideningStatus::Declined);
    ///  - approved and unexpired, its session still live: the first poll
    ///    claims it and mints the session's new token, together or not at
    ///    all; [`Widened`](SessionWideningStatus::Widened) with the token;
    ///  - anything else (expired, claimed already, its session ended):
    ///    [`Expired`](SessionWideningStatus::Expired).
    ///
    /// Once a claim has committed, the presented token is revoked, so the
    /// narrower token it replaces stops working; revoking is best-effort,
    /// and a failure is logged.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::SessionWideningNotFound`] when no widening
    /// asked in the presented session has the id; a store or minting failure.
    pub(crate) fn poll(
        &self,
        widening_id: &str,
        presented_session: &VerifiedClaims,
        now: DateTime<Utc>,
    ) -> Result<SessionWideningStatus, SessionWideningPollError> {
        let polled = self.store.write(|tx| {
            let widening_request = tx
                .session_widening_request_by_id(widening_id)?
                .filter(|widening_request| {
                    presented_session.sid.as_deref() == Some(widening_request.sid.as_str())
                })
                .ok_or_else(|| AuthorizationServerError::SessionWideningNotFound {
                    id: widening_id.to_owned(),
                })?;
            match widening_request.state {
                PolledState::Pending if widening_request.is_pending_at(now) => {
                    Ok(PolledWidening::Answered(SessionWideningStatus::Pending))
                }
                PolledState::Denied => {
                    Ok(PolledWidening::Answered(SessionWideningStatus::Declined))
                }
                PolledState::Approved(_) => self.claim_widened_session(tx, &widening_request, now),
                PolledState::Pending | PolledState::Claimed(_) => {
                    Ok(PolledWidening::Answered(SessionWideningStatus::Expired))
                }
            }
        })?;
        match polled {
            PolledWidening::Answered(status) => Ok(status),
            PolledWidening::Claimed {
                session_token,
                session_ttl,
            } => {
                self.revoke_replaced_token(presented_session);
                Ok(SessionWideningStatus::Widened {
                    session_token,
                    session_ttl,
                })
            }
        }
    }

    /// Claim the approved `widening_request` and mint its session's new
    /// token, living until the session ends, inside the poll's scope `tx`.
    /// One another poll claimed first, or whose session has ended, is
    /// [`Expired`](SessionWideningStatus::Expired).
    fn claim_widened_session(
        &self,
        tx: &mut impl GrantTx,
        widening_request: &SessionWideningRequest,
        now: DateTime<Utc>,
    ) -> Result<PolledWidening, SessionWideningPollError> {
        let Some(claimed_widening) =
            ClaimedSessionWidening::claim(tx, widening_request, &self.stale_session_cutoff, now)?
        else {
            return Ok(PolledWidening::Answered(SessionWideningStatus::Expired));
        };
        let session_ttl = claimed_widening.session().expires_at - now;
        let session_token =
            AccessTokenMinter::with_active_key(tx, &self.server_origin, session_ttl)
                .and_then(|minter| {
                    minter.mint(TokenEntitlement::SessionWidening(&claimed_widening))
                })
                .map_err(SessionWideningPollError::Issuance)?;
        Ok(PolledWidening::Claimed {
            session_token,
            session_ttl,
        })
    }

    /// Denylist the presented session token, which the widened one replaces,
    /// until it would have expired. A token with no `jti` or `exp` has
    /// nothing to denylist.
    fn revoke_replaced_token(&self, presented_session: &VerifiedClaims) {
        let (Some(jti), Some(expires_at)) = (
            presented_session.jti.as_deref(),
            presented_session.expires_at,
        ) else {
            return;
        };
        if let Err(error) = self
            .revocation
            .revoke_jti(jti, expires_at, "browser session widened")
        {
            tracing::warn!(%error, "session widening: failed to revoke the replaced session token");
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::domain::access_token::{verify_access_token, AccessTokenVerifyOptions};
    use crate::domain::authorization_request::code::{CodeRequest, NewCodeRequestArgs};
    use crate::domain::authorization_request::RequestStatus;
    use crate::domain::browser_session::BrowserSession;
    use crate::domain::capabilities::access::ConsentDecider;
    use crate::domain::grant_store::*;
    use crate::domain::owner_prompt::OwnerPrompt;
    use crate::domain::signing_key::SigningKey;
    use crate::domain::test_fake::{
        client, fixture_code_args, owned_scopes, seed_active_signing_key, FakeGrantStore,
        RecordingOwnerApproval, FIXTURE_SID,
    };
    use crate::BROWSER_SESSION_CLIENT_ID;

    /// The server's origin: the session token's `iss` and `aud`.
    const SERVER_ORIGIN: &str = "https://ruth.relay.example";

    /// A revocation port recording each `jti` it revokes.
    #[derive(Default)]
    struct RecordingRevocation {
        /// Each revoked `jti`, in call order.
        revoked_jtis: Mutex<Vec<String>>,
    }

    impl Revocation for RecordingRevocation {
        fn revoke_jti(
            &self,
            jti: &str,
            _expires_at: DateTime<Utc>,
            _reason: &str,
        ) -> Result<(), String> {
            self.revoked_jtis.lock().unwrap().push(jti.to_owned());
            Ok(())
        }

        fn revoke_subject_as_of_now(&self, _subject: &str) -> Result<(), String> {
            unreachable!("a widening revokes a jti, never a subject")
        }
    }

    /// What every test here works over.
    struct Fixture {
        /// The capability under test.
        session_widening: SessionWidening<FakeGrantStore>,
        /// The port it republishes through.
        owner_approval: Arc<RecordingOwnerApproval>,
        /// The port it revokes through.
        revocation: Arc<RecordingRevocation>,
        /// The key the session tokens are signed with.
        signing_key: SigningKey,
    }

    /// A store with a signing key, the app `app` registered, the paired
    /// session [`FIXTURE_SID`] holding `wildflower/launch` and
    /// `patient/Patient.rs`, and the code request `req-1` from `app`, made in
    /// it and asking for `patient/Patient.r` and `patient/Observation.r`,
    /// waiting on its limited page.
    fn fixture() -> Fixture {
        let store = FakeGrantStore::default();
        let signing_key = seed_active_signing_key(&store);
        store
            .tx()
            .upsert_client(&client("app", &["patient/Patient.r"]))
            .unwrap();
        store
            .tx()
            .insert_browser_session(&BrowserSession {
                sid: FIXTURE_SID.to_owned(),
                ..BrowserSession::new_paired_session(
                    "Firefox on Linux".to_owned(),
                    owned_scopes(&["wildflower/launch", "patient/Patient.rs"]),
                    Duration::hours(24),
                    Utc::now(),
                )
            })
            .unwrap();
        store
            .tx()
            .insert_code_request(&CodeRequest::new(
                NewCodeRequestArgs {
                    awaits_limited_page: true,
                    ..fixture_code_args(
                        "req-1",
                        "app",
                        owned_scopes(&["openid", "patient/Patient.r", "patient/Observation.r"]),
                    )
                },
                Utc::now(),
            ))
            .unwrap();
        let owner_approval = Arc::new(RecordingOwnerApproval::default());
        let revocation = Arc::new(RecordingRevocation::default());
        Fixture {
            session_widening: SessionWidening::new(
                store,
                owner_approval.clone(),
                revocation.clone(),
                SERVER_ORIGIN.into(),
                Arc::new(StaleSessionCutoff::none()),
            ),
            owner_approval,
            revocation,
            signing_key,
        }
    }

    /// The claims of the session token the browser in `sid` presents: `jti`,
    /// living another hour.
    fn presented_session(sid: &str, jti: &str) -> VerifiedClaims {
        VerifiedClaims {
            issuer: SERVER_ORIGIN.to_owned(),
            subject: BROWSER_SESSION_CLIENT_ID.to_owned(),
            jti: Some(jti.to_owned()),
            audience: vec![SERVER_ORIGIN.to_owned()],
            expires_at: Some(Utc::now() + Duration::hours(1)),
            issued_at: Some(Utc::now()),
            scope: Some("wildflower/launch patient/Patient.rs".to_owned()),
            patient: None,
            sid: Some(sid.to_owned()),
        }
    }

    /// Ask, as the page does, for `fixture`'s request `req-1` at `now`, the
    /// start limit admitting it, and return the widening's id.
    fn asked_widening_id(fixture: &Fixture, now: DateTime<Utc>) -> String {
        match fixture
            .session_widening
            .ask("req-1", FIXTURE_SID, || true, now)
            .expect("asks")
        {
            SessionWideningAsk::Asked { widening_id } => widening_id,
            SessionWideningAsk::StartLimited => panic!("the start limit admitted it"),
        }
    }

    /// A decider acting as the Owner over `fixture`'s store.
    fn owner(fixture: &Fixture) -> ConsentDecider<FakeGrantStore> {
        ConsentDecider::new(
            fixture.session_widening.store.clone(),
            fixture.owner_approval.clone(),
            Grant::parse(crate::owner_scopes()),
            Arc::new(StaleSessionCutoff::none()),
        )
    }

    /// An ask files a widening for exactly what the session lacks of the
    /// request, named after the session's browser and the request's app,
    /// keeps the request on its limited page as long, and notifies the
    /// Owner.
    #[test]
    fn an_ask_files_a_widening_for_what_the_session_lacks() {
        let fixture = fixture();
        let now = Utc::now() + Duration::minutes(3);
        let widening_id = asked_widening_id(&fixture, now);
        let store = &fixture.session_widening.store;
        let widening_request = store
            .tx()
            .session_widening_request_by_id(&widening_id)
            .unwrap()
            .expect("filed");
        assert_eq!(
            widening_request,
            SessionWideningRequest::new(
                NewSessionWideningRequestArgs {
                    id: widening_id.clone(),
                    sid: FIXTURE_SID.to_owned(),
                    client_id: "app".to_owned(),
                    browser_name: "Firefox on Linux".to_owned(),
                    requested_scopes: owned_scopes(&["patient/Observation.r"]),
                    ttl: AUTHORIZATION_REQUEST_TTL,
                },
                now,
            )
        );
        let code_request = store.tx().code_request_by_id("req-1").unwrap().unwrap();
        assert_eq!(
            code_request.state.status(),
            RequestStatus::AwaitingLimitedPage
        );
        assert_eq!(
            code_request.expires_at,
            widening_request.asking_code_request_expires_at()
        );
        assert_eq!(fixture.owner_approval.count(), 1);
        assert_eq!(
            store.tx().owner_prompt(now).unwrap(),
            Some(OwnerPrompt::SessionWidening {
                id: widening_id,
                browser_name: "Firefox on Linux".to_owned(),
            })
        );
    }

    /// Asking again while the widening waits for the Owner answers that
    /// widening: nothing new is filed, the Owner isn't told again, the start
    /// limit isn't asked, and the request waits no longer. Once the start
    /// limit refuses a new widening, nothing is filed.
    #[test]
    fn asking_again_answers_the_widening_still_waiting() {
        let fixture = fixture();
        let now = Utc::now();
        let widening_id = asked_widening_id(&fixture, now);
        let store = &fixture.session_widening.store;
        let waiting_until = store
            .tx()
            .code_request_by_id("req-1")
            .unwrap()
            .unwrap()
            .expires_at;
        assert_eq!(
            fixture.session_widening.ask(
                "req-1",
                FIXTURE_SID,
                || panic!("the start limit isn't asked"),
                now + Duration::minutes(1)
            ),
            Ok(SessionWideningAsk::Asked {
                widening_id: widening_id.clone()
            })
        );
        assert_eq!(fixture.owner_approval.count(), 1);
        assert_eq!(
            store
                .tx()
                .pending_session_widening_requests_for_session(FIXTURE_SID, now)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            store
                .tx()
                .code_request_by_id("req-1")
                .unwrap()
                .unwrap()
                .expires_at,
            waiting_until
        );

        owner(&fixture)
            .deny_session_widening(&widening_id, now)
            .expect("denies");
        let republished = fixture.owner_approval.count();
        assert_eq!(
            fixture
                .session_widening
                .ask("req-1", FIXTURE_SID, || false, now),
            Ok(SessionWideningAsk::StartLimited)
        );
        assert_eq!(fixture.owner_approval.count(), republished);
        assert!(store
            .tx()
            .pending_session_widening_requests_for_session(FIXTURE_SID, now)
            .unwrap()
            .is_empty());
    }

    /// An approval in the decision window's last second is still collected
    /// by a poll just past it, and the request still waits on its limited
    /// page for the browser to go on with.
    #[test]
    fn an_approval_at_the_deadline_is_collected_after_it() {
        let fixture = fixture();
        let asked_at = Utc::now();
        let widening_id = asked_widening_id(&fixture, asked_at);
        let deadline = asked_at + AUTHORIZATION_REQUEST_TTL;
        owner(&fixture)
            .approve_session_widening(
                &widening_id,
                owned_scopes(&["patient/Observation.r"]),
                deadline - Duration::seconds(1),
            )
            .expect("approves");
        let after_deadline = deadline + Duration::seconds(3);
        assert!(matches!(
            fixture.session_widening.poll(
                &widening_id,
                &presented_session(FIXTURE_SID, "jti-1"),
                after_deadline
            ),
            Ok(SessionWideningStatus::Widened { .. })
        ));
        assert!(fixture
            .session_widening
            .store
            .tx()
            .code_request_by_id("req-1")
            .unwrap()
            .unwrap()
            .is_awaiting_limited_page_at(after_deadline));
    }

    /// Nothing is asked for another session's request, a session that lacks
    /// nothing of it, or the Owner's own same-device session: each reads as
    /// the request not being found, and nothing is filed or republished.
    #[test]
    fn an_ask_with_nothing_to_widen_finds_no_request() {
        let not_found = Err(AuthorizationServerError::AuthorizationRequestNotFound {
            id: "req-1".to_owned(),
        });

        let fixture = fixture();
        assert_eq!(
            fixture
                .session_widening
                .ask("req-1", "another-sid", || true, Utc::now()),
            not_found
        );

        let fixture = self::fixture();
        fixture
            .session_widening
            .store
            .tx()
            .update_browser_session_scopes(FIXTURE_SID, &crate::owner_scopes())
            .unwrap();
        assert_eq!(
            fixture
                .session_widening
                .ask("req-1", FIXTURE_SID, || true, Utc::now()),
            not_found
        );

        let fixture = self::fixture();
        fixture
            .session_widening
            .store
            .tx()
            .insert_browser_session(&BrowserSession {
                sid: FIXTURE_SID.to_owned(),
                ..BrowserSession::new_same_device_session(
                    owned_scopes(&["patient/Patient.rs"]),
                    Duration::hours(8),
                    Utc::now(),
                )
            })
            .unwrap();
        assert_eq!(
            fixture
                .session_widening
                .ask("req-1", FIXTURE_SID, || true, Utc::now()),
            not_found
        );
        assert_eq!(fixture.owner_approval.count(), 0);
        assert_eq!(
            fixture
                .session_widening
                .store
                .tx()
                .owner_prompt(Utc::now())
                .unwrap(),
            None
        );
    }

    /// The poll answers pending until the Owner decides. Once the Owner
    /// approves, the session's row holds what was granted, and the first poll
    /// collects it: a token for the same session, carrying what it holds now
    /// and living until the session ends, while the token it replaces is
    /// revoked. A later poll finds nothing more to collect.
    #[test]
    fn the_first_poll_after_approval_collects_the_wider_session() {
        let fixture = fixture();
        let widening_id = asked_widening_id(&fixture, Utc::now());
        let presented = presented_session(FIXTURE_SID, "narrow-jti");
        assert_eq!(
            fixture
                .session_widening
                .poll(&widening_id, &presented, Utc::now())
                .unwrap(),
            SessionWideningStatus::Pending
        );
        owner(&fixture)
            .approve_session_widening(
                &widening_id,
                owned_scopes(&["patient/Observation.r"]),
                Utc::now(),
            )
            .expect("approves");
        let session = fixture
            .session_widening
            .store
            .tx()
            .browser_session_by_sid(FIXTURE_SID)
            .unwrap()
            .unwrap();
        assert_eq!(
            session.scopes,
            [
                "wildflower/launch",
                "patient/Patient.rs",
                "patient/Observation.r"
            ]
        );

        let now = Utc::now();
        let SessionWideningStatus::Widened {
            session_token,
            session_ttl,
        } = fixture
            .session_widening
            .poll(&widening_id, &presented, now)
            .unwrap()
        else {
            panic!("widened");
        };
        assert_eq!(session_ttl, session.expires_at - now);
        let claims = verify_access_token(
            &session_token,
            std::slice::from_ref(&fixture.signing_key),
            &AccessTokenVerifyOptions {
                expected_issuer: SERVER_ORIGIN,
                accepted_audiences: &[SERVER_ORIGIN.to_owned()],
            },
        )
        .expect("a token this server accepts");
        assert_eq!(claims.subject, BROWSER_SESSION_CLIENT_ID);
        assert_eq!(claims.sid.as_deref(), Some(FIXTURE_SID));
        assert_eq!(
            claims.scope.as_deref(),
            Some("wildflower/launch patient/Patient.rs patient/Observation.r")
        );
        assert_eq!(
            *fixture.revocation.revoked_jtis.lock().unwrap(),
            ["narrow-jti"]
        );
        assert_eq!(
            fixture
                .session_widening
                .poll(&widening_id, &presented, Utc::now())
                .unwrap(),
            SessionWideningStatus::Expired
        );
    }

    /// A declined widening says so and leaves the session as it was; a
    /// widening polled from another session is not found.
    #[test]
    fn a_declined_widening_leaves_the_session_and_only_its_session_polls_it() {
        let fixture = fixture();
        let widening_id = asked_widening_id(&fixture, Utc::now());
        owner(&fixture)
            .deny_session_widening(&widening_id, Utc::now())
            .expect("denies");
        assert_eq!(
            fixture
                .session_widening
                .poll(
                    &widening_id,
                    &presented_session(FIXTURE_SID, "jti-1"),
                    Utc::now()
                )
                .unwrap(),
            SessionWideningStatus::Declined
        );
        assert_eq!(
            fixture
                .session_widening
                .store
                .tx()
                .browser_session_by_sid(FIXTURE_SID)
                .unwrap()
                .unwrap()
                .scopes,
            ["wildflower/launch", "patient/Patient.rs"]
        );
        assert!(matches!(
            fixture.session_widening.poll(
                &widening_id,
                &presented_session("another-sid", "jti-2"),
                Utc::now()
            ),
            Err(SessionWideningPollError::Store(
                AuthorizationServerError::SessionWideningNotFound { .. }
            ))
        ));
        assert!(fixture.revocation.revoked_jtis.lock().unwrap().is_empty());
    }

    /// A widening the Owner didn't decide in time has expired; so has one
    /// whose session ended before its approval was collected.
    #[test]
    fn an_undecided_or_orphaned_widening_has_expired() {
        let fixture = fixture();
        let widening_id = asked_widening_id(&fixture, Utc::now());
        let presented = presented_session(FIXTURE_SID, "jti-1");
        assert_eq!(
            fixture
                .session_widening
                .poll(
                    &widening_id,
                    &presented,
                    Utc::now() + AUTHORIZATION_REQUEST_TTL
                )
                .unwrap(),
            SessionWideningStatus::Expired
        );
        owner(&fixture)
            .approve_session_widening(
                &widening_id,
                owned_scopes(&["patient/Observation.r"]),
                Utc::now(),
            )
            .expect("approves");
        fixture
            .session_widening
            .store
            .tx()
            .revoke_browser_session(FIXTURE_SID, Utc::now())
            .unwrap();
        assert_eq!(
            fixture
                .session_widening
                .poll(&widening_id, &presented, Utc::now())
                .unwrap(),
            SessionWideningStatus::Expired
        );
        assert!(fixture.revocation.revoked_jtis.lock().unwrap().is_empty());
    }
}
