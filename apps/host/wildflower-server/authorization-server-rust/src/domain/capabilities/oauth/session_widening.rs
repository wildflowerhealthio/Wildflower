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

/// How long the session token a widening replaces keeps working after the
/// poll that collected the wider one. The browser's requests already in
/// flight with the old cookie (another tab's read, a refetch) still verify,
/// so the host's cookie layer doesn't answer them by clearing the cookie,
/// which could wipe the wider one the browser has just been handed.
pub(crate) const REPLACED_SESSION_TOKEN_GRACE: Duration = Duration::seconds(30);

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
    /// Once a claim has committed, the presented token is revoked from
    /// [`REPLACED_SESSION_TOKEN_GRACE`] on, so the narrower token it replaces
    /// stops working once the browser's requests already in flight with it
    /// have landed; revoking is best-effort, and a failure is logged.
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
                self.revoke_replaced_token(presented_session, now);
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
    /// from [`REPLACED_SESSION_TOKEN_GRACE`] after `now` until it would have
    /// expired. A token with no `jti` or `exp` has nothing to denylist.
    fn revoke_replaced_token(&self, presented_session: &VerifiedClaims, now: DateTime<Utc>) {
        let (Some(jti), Some(expires_at)) = (
            presented_session.jti.as_deref(),
            presented_session.expires_at,
        ) else {
            return;
        };
        if let Err(error) = self.revocation.revoke_jti_from(
            jti,
            now + REPLACED_SESSION_TOKEN_GRACE,
            expires_at,
            "browser session widened",
        ) {
            tracing::warn!(%error, "session widening: failed to revoke the replaced session token");
        }
    }
}
