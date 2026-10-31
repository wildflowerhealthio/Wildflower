//! [`SessionShortfall`] — the limited page's side of a request whose browser
//! session holds less than the request asks for. `/oauth/authorize` parks such
//! a request awaiting the limited page and sends the browser there, which
//! reads what the session lacks and then goes on
//! ([`CodeAuthorizationStarter::continue_past_session_shortfall`]) or cancels.
//! Every operation answers only the browser session the request was made in,
//! so a leaked request id reads, continues and cancels nothing. What a session
//! holds is read from its row ([`browser_session_grant`]), which a widening
//! the Owner approved grows, so the page and `/oauth/authorize` see the wider
//! session whether or not the browser has taken its wider token yet.
//!
//! [`CodeAuthorizationStarter::continue_past_session_shortfall`]:
//! super::CodeAuthorizationStarter::continue_past_session_shortfall

use std::sync::Arc;

use chrono::{DateTime, Utc};
use wildflowerhealthio_scopes::Grant;

use crate::domain::authority::session_shortfall;
use crate::domain::authorization_request::code::CodeRequest;
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::browser_session::StaleSessionCutoff;
use crate::domain::client_redirect::{
    build_client_error_redirect_url, REQUEST_DECLINED_DESCRIPTION,
};
use crate::domain::grant_store::{AuthorizationRequestsTx, BrowserSessionsTx, ClientsTx as _};
use crate::domain::oauth_error_code::OAuthErrorCode;
use crate::domain::GrantStore;

/// What the limited page says: the app, and the requested scopes the browser's
/// session lacks.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct SessionShortfallView {
    /// The client's registered name, or its `client_id` when it has no
    /// registration yet (a client trusted on first use, asking for the first
    /// time).
    pub(crate) client_name: String,
    /// The requested scopes a code issued in this session would not carry in
    /// full ([`session_shortfall`]), in the request's order: dropped outright,
    /// or narrowed to what the session holds.
    pub(crate) missing_scopes: Vec<String>,
}

/// The grant the browser session `sid` holds at `now`, as its row records it:
/// what a code issued under it may carry at most. `None` once the session has
/// ended (revoked, expired, stale under `stale_session_cutoff`, or pruned
/// since), when no code is issued under it at all.
///
/// # Errors
///
/// [`AuthorizationServerError::Infrastructure`] on a store failure.
pub(crate) fn browser_session_grant(
    tx: &mut impl BrowserSessionsTx,
    sid: &str,
    stale_session_cutoff: &StaleSessionCutoff,
    now: DateTime<Utc>,
) -> Result<Option<Grant>, AuthorizationServerError> {
    Ok(tx
        .browser_session_by_sid(sid)?
        .filter(|browser_session| browser_session.is_live_at(now, stale_session_cutoff))
        .map(|browser_session| Grant::parse(browser_session.scopes)))
}

/// Load request `id` for the browser session `sid` while it waits on that
/// browser's limited page: an unexpired code request made in `sid`, awaiting
/// the page. Anything else (an unknown id, another session's request, one
/// gone on, decided or expired) is
/// [`AuthorizationServerError::AuthorizationRequestNotFound`], the status
/// poll's `404`, so the answer says nothing about whether `id` exists.
pub(crate) fn load_code_request_awaiting_limited_page(
    tx: &mut impl AuthorizationRequestsTx,
    id: &str,
    sid: &str,
    now: DateTime<Utc>,
) -> Result<CodeRequest, AuthorizationServerError> {
    let not_found = || AuthorizationServerError::AuthorizationRequestNotFound { id: id.to_owned() };
    tx.code_request_by_id(id)?
        .filter(|request| request.is_awaiting_limited_page_at(now) && request.sid == sid)
        .ok_or_else(not_found)
}

/// Read and cancel requests waiting on their browser's limited page. Public
/// (the caller is the browser that made the request, identified by its
/// browser session), so its only powers are these two.
pub(crate) struct SessionShortfall<S: GrantStore> {
    /// The store the waiting request is read from and denied in.
    store: S,
    /// The cutoff before which a same-device session is stale: a stale
    /// session holds nothing.
    stale_session_cutoff: Arc<StaleSessionCutoff>,
}

impl<S: GrantStore> SessionShortfall<S> {
    /// Build it over a store handle and the stale-session cutoff, lifted from
    /// the state.
    pub(crate) fn new(store: S, stale_session_cutoff: Arc<StaleSessionCutoff>) -> Self {
        SessionShortfall {
            store,
            stale_session_cutoff,
        }
    }

    /// What request `id` asks for that the browser session `sid` doesn't
    /// hold, and the app asking, in a read scope. The missing scopes come from
    /// [`session_shortfall`] against the session's grant as its row holds it
    /// now ([`browser_session_grant`]), the same check `/oauth/authorize`
    /// made when it parked the request, so a session the Owner widened since
    /// lacks only what it still lacks.
    ///
    /// # Errors
    ///
    /// See [`load_code_request_awaiting_limited_page`];
    /// [`AuthorizationServerError::AuthorizationRequestNotFound`] too once the
    /// session has ended, as the ask answers, since no code is issued under
    /// it; the store's.
    pub(crate) fn read(
        &self,
        id: &str,
        sid: &str,
        now: DateTime<Utc>,
    ) -> Result<SessionShortfallView, AuthorizationServerError> {
        self.store.read(|tx| {
            let request = load_code_request_awaiting_limited_page(tx, id, sid, now)?;
            let session_grant = browser_session_grant(tx, sid, &self.stale_session_cutoff, now)?
                .ok_or_else(|| AuthorizationServerError::AuthorizationRequestNotFound {
                    id: id.to_owned(),
                })?;
            let client_name = tx
                .client_by_id(&request.client_id)?
                .map_or_else(|| request.client_id.clone(), |client| client.name);
            Ok(SessionShortfallView {
                client_name,
                missing_scopes: session_shortfall(&request.requested_scopes, &session_grant),
            })
        })
    }

    /// Deny request `id`, made in the browser session `sid`, and return the
    /// client callback carrying `error=access_denied`. The denial holds only
    /// while the request still waits on the page, so a Continue that
    /// went on with it meanwhile wins and this answers not found. The Owner
    /// was never told of a request still waiting here, so nothing is
    /// republished. A Cancel isn't remembered: unlike a Continue it records
    /// nothing for the session and the client, so the browser's next request
    /// for the client stops at the page again.
    ///
    /// # Errors
    ///
    /// See [`load_code_request_awaiting_limited_page`]; the store's.
    pub(crate) fn cancel(
        &self,
        id: &str,
        sid: &str,
        now: DateTime<Utc>,
    ) -> Result<String, AuthorizationServerError> {
        let not_found =
            || AuthorizationServerError::AuthorizationRequestNotFound { id: id.to_owned() };
        let cancelled = self.store.write(|tx| {
            let request = load_code_request_awaiting_limited_page(tx, id, sid, now)?;
            let cancelled = request.deny_on_limited_page(now).map_err(|_| not_found())?;
            if tx.replace_code_request(&request, &cancelled)? {
                Ok(cancelled)
            } else {
                Err(not_found())
            }
        })?;
        Ok(build_client_error_redirect_url(
            &cancelled.redirect_uri,
            OAuthErrorCode::AccessDenied,
            REQUEST_DECLINED_DESCRIPTION,
            &cancelled.client_state,
        ))
    }
}

#[cfg(test)]
mod tests {
    use crate::domain::grant_store::*;
    use chrono::Duration;

    use super::*;
    use crate::domain::authorization_request::code::NewCodeRequestArgs;
    use crate::domain::authorization_request::RequestStatus;
    use crate::domain::browser_session::BrowserSession;
    use crate::domain::test_fake::{
        client, code_with_status, fixture_code_args, owned_scopes, FakeGrantStore, FIXTURE_SID,
    };

    /// A code request `id`, asking for `patient/Patient.r` and
    /// `patient/Observation.r`, expiring at `expires_at`, awaiting its
    /// limited page or gone on past it.
    fn code_request(id: &str, expires_at: DateTime<Utc>, awaits_limited_page: bool) -> CodeRequest {
        let now = Utc::now();
        CodeRequest::new(
            NewCodeRequestArgs {
                ttl: expires_at - now,
                awaits_limited_page,
                ..fixture_code_args(
                    id,
                    "client",
                    owned_scopes(&["openid", "patient/Patient.r", "patient/Observation.r"]),
                )
            },
            now,
        )
    }

    /// [`code_request`] `id`, live for five minutes, waiting on its limited
    /// page.
    fn awaiting_limited_page(id: &str) -> CodeRequest {
        code_request(id, Utc::now() + Duration::minutes(5), true)
    }

    /// The stored status of request `id`.
    fn status_of(session_shortfall: &SessionShortfall<FakeGrantStore>, id: &str) -> RequestStatus {
        session_shortfall
            .store
            .tx()
            .code_request_by_id(id)
            .unwrap()
            .expect("present")
            .state
            .status()
    }

    /// Start the paired browser session `sid` in `store`, holding `scopes`.
    fn seed_session(store: &FakeGrantStore, sid: &str, scopes: &[&str]) {
        store
            .tx()
            .insert_browser_session(&BrowserSession {
                sid: sid.to_owned(),
                ..BrowserSession::new_paired_session(
                    "Firefox on Linux".to_owned(),
                    owned_scopes(scopes),
                    Duration::hours(24),
                    Utc::now(),
                )
            })
            .unwrap();
    }

    /// The page reads the app's name and what the session lacks of the
    /// request, in the request's order.
    #[test]
    fn the_read_names_the_app_and_what_the_session_lacks() {
        let store = FakeGrantStore::default();
        store
            .tx()
            .upsert_client(&client("client", &["patient/Patient.r"]))
            .unwrap();
        store
            .tx()
            .insert_code_request(&awaiting_limited_page("req-1"))
            .unwrap();
        seed_session(&store, FIXTURE_SID, &["patient/Patient.rs"]);
        let session_shortfall = SessionShortfall::new(store, Arc::new(StaleSessionCutoff::none()));
        let view = session_shortfall
            .read("req-1", FIXTURE_SID, Utc::now())
            .expect("the requesting session reads it");
        assert_eq!(
            view,
            SessionShortfallView {
                client_name: "client display name".to_owned(),
                missing_scopes: vec!["patient/Observation.r".to_owned()],
            }
        );
    }

    /// What the session lacks is read from its row as it stands: a session
    /// the Owner widened since lacks only the rest, and once it has ended the
    /// request reads as not found.
    #[test]
    fn the_read_takes_what_the_session_holds_from_its_row_now() {
        let store = FakeGrantStore::default();
        store
            .tx()
            .insert_code_request(&awaiting_limited_page("req-1"))
            .unwrap();
        seed_session(&store, FIXTURE_SID, &["patient/Patient.rs"]);
        store
            .tx()
            .update_browser_session_scopes(
                FIXTURE_SID,
                &owned_scopes(&["patient/Patient.rs", "patient/Observation.rs"]),
            )
            .unwrap();
        let session_shortfall = SessionShortfall::new(store, Arc::new(StaleSessionCutoff::none()));
        let now = Utc::now();
        assert_eq!(
            session_shortfall
                .read("req-1", FIXTURE_SID, now)
                .expect("reads")
                .missing_scopes,
            Vec::<String>::new()
        );
        session_shortfall
            .store
            .tx()
            .revoke_browser_session(FIXTURE_SID, now)
            .unwrap();
        assert_eq!(
            session_shortfall.read("req-1", FIXTURE_SID, now),
            Err(AuthorizationServerError::AuthorizationRequestNotFound {
                id: "req-1".to_owned()
            })
        );
    }

    /// Another session, a request gone on past the page, an expired one, a
    /// decided one and an unknown id all read as not found.
    #[test]
    fn only_the_requesting_session_reads_a_request_still_waiting_on_its_page() {
        let store = FakeGrantStore::default();
        let now = Utc::now();
        store
            .tx()
            .insert_code_request(&awaiting_limited_page("waiting"))
            .unwrap();
        store
            .tx()
            .insert_code_request(&code_request("gone-on", now + Duration::minutes(5), false))
            .unwrap();
        store
            .tx()
            .insert_code_request(&code_request("expired", now - Duration::seconds(1), true))
            .unwrap();
        store
            .tx()
            .insert_code_request(&code_with_status(
                code_request("denied", now + Duration::minutes(5), false),
                RequestStatus::Denied,
            ))
            .unwrap();
        let session_shortfall = SessionShortfall::new(store, Arc::new(StaleSessionCutoff::none()));
        for (id, sid) in [
            ("waiting", "another-sid"),
            ("gone-on", FIXTURE_SID),
            ("expired", FIXTURE_SID),
            ("denied", FIXTURE_SID),
            ("ghost", FIXTURE_SID),
        ] {
            assert_eq!(
                session_shortfall.read(id, sid, now),
                Err(AuthorizationServerError::AuthorizationRequestNotFound { id: id.to_owned() }),
                "{id} from {sid}"
            );
            assert_eq!(
                session_shortfall.cancel(id, sid, now),
                Err(AuthorizationServerError::AuthorizationRequestNotFound { id: id.to_owned() }),
                "{id} from {sid}"
            );
        }
    }

    /// Cancel denies the request and hands back the client's `access_denied`
    /// callback, and remembers nothing for the session; a second cancel finds
    /// nothing.
    #[test]
    fn cancel_denies_the_request_and_answers_access_denied() {
        let store = FakeGrantStore::default();
        store
            .tx()
            .insert_code_request(&awaiting_limited_page("req-1"))
            .unwrap();
        let session_shortfall = SessionShortfall::new(store, Arc::new(StaleSessionCutoff::none()));
        let callback = session_shortfall
            .cancel("req-1", FIXTURE_SID, Utc::now())
            .expect("cancels");
        assert_eq!(
            callback,
            "https://example.com/cb?error=access_denied\
             &error_description=The+request+was+declined.&state=state"
        );
        assert_eq!(
            status_of(&session_shortfall, "req-1"),
            RequestStatus::Denied
        );
        assert!(!session_shortfall
            .store
            .tx()
            .is_session_shortfall_acknowledged_for_client(FIXTURE_SID, "client")
            .unwrap());
        assert!(session_shortfall
            .cancel("req-1", FIXTURE_SID, Utc::now())
            .is_err());
    }

    /// A Cancel that read the request before a Continue went on with it
    /// doesn't deny it after: the Continue wins and the Cancel lands nowhere.
    #[test]
    fn a_cancel_racing_a_continue_leaves_the_continued_request_alone() {
        let store = FakeGrantStore::default();
        store
            .tx()
            .insert_code_request(&awaiting_limited_page("req-1"))
            .unwrap();
        let session_shortfall = SessionShortfall::new(store, Arc::new(StaleSessionCutoff::none()));
        let now = Utc::now();
        let read_by_cancel = load_code_request_awaiting_limited_page(
            &mut session_shortfall.store.tx(),
            "req-1",
            FIXTURE_SID,
            now,
        )
        .expect("the Cancel reads it first");
        let continued = read_by_cancel
            .acknowledge_session_shortfall(Duration::minutes(5), now)
            .expect("the Continue goes on with it");
        assert!(session_shortfall
            .store
            .tx()
            .replace_code_request(&read_by_cancel, &continued)
            .unwrap());
        let cancelled = read_by_cancel
            .deny_on_limited_page(now)
            .expect("the Cancel's read still waits");
        assert!(!session_shortfall
            .store
            .tx()
            .replace_code_request(&read_by_cancel, &cancelled)
            .unwrap());
        assert_eq!(
            status_of(&session_shortfall, "req-1"),
            RequestStatus::Pending
        );
    }
}
