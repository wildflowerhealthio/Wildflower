//! [`BrowserPairing`] — how a browser that isn't the Owner's gets a browser
//! session: the pairing page (`GET /oauth/pair`) starts a pairing request,
//! shows its `user_code`, and polls until the Owner decides it at the device
//! page. Pairing is no OAuth flow: no client redeems it at `/oauth/token`, and
//! it records no grant and no refresh family. Once the Owner approves, the
//! poll claims the request ([`ClaimedBrowserPairing`]), stores the approved
//! session it starts, and mints that session's token, which the browser holds
//! as its browser session cookie.
//!
//! The poll is bound to the request by its pairing code, a 256-bit secret
//! that only the page that started the request holds, as a device holds its
//! `device_code`.

use std::sync::Arc;

use chrono::{DateTime, Duration, Utc};

use super::device_authorizer::{generate_unique_user_code, DEVICE_AUTHORIZATION_TTL};
use crate::crypto_util::random_token::generate_authorization_code;
use crate::domain::authority::{ClaimedBrowserPairing, TokenEntitlement};
use crate::domain::authorization_request::{
    AuthorizationRequest, GrantType, RequestStatus, StartBrowserPairingArgs,
    DEVICE_CODE_POLL_INTERVAL,
};
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::capabilities::writers::{AccessTokenMinter, BrowserSessionWriter};
use crate::domain::sign_in_redirect::{SignInDestinations, SignInRedirect};
use crate::domain::token::TokenIssuanceError;
use crate::domain::GrantStore;
use crate::ports::OwnerApproval;
use crate::BROWSER_SESSION_CLIENT_ID;

/// How long an approved browser session lasts, absolute: a day. The session's
/// token lives as long, and the browser's cookie with it.
pub(crate) const APPROVED_SESSION_TTL: Duration = Duration::hours(24);

/// The name a pairing goes by when its browser's user agent names nothing
/// recognizable, until the browser names itself.
const UNRECOGNIZED_BROWSER_NAME: &str = "Browser";

/// The scopes a pairing requests: the Owner's
/// ([`OWNER_SCOPES`](crate::OWNER_SCOPES)), the most a browser session may
/// hold. Its card opens with everything the approver may delegate ticked, so
/// the approver unticks what the browser shouldn't have.
fn pairing_requested_scopes() -> Vec<String> {
    crate::owner_scopes()
}

/// A started pairing: what the pairing page shows and polls with.
#[derive(Debug)]
pub(crate) struct StartedBrowserPairing {
    /// The secret the page polls with.
    pub(crate) pairing_code: String,
    /// The code the page shows, which the Owner confirms at the device page.
    pub(crate) user_code: String,
    /// The name the request goes by until the browser names itself.
    pub(crate) browser_name: String,
    /// Where the page sends the browser once it holds its session.
    pub(crate) next: SignInRedirect,
    /// Seconds until the request expires.
    pub(crate) expires_in: i64,
    /// Seconds the page waits between polls.
    pub(crate) interval: i64,
}

/// Why a pairing couldn't start.
#[derive(Debug)]
pub(crate) enum BrowserPairingStartError {
    /// `next` is no path on this server.
    NextNotAllowed,
    /// The browser-session client, which every browser session's token is
    /// issued to, is disabled.
    BrowserSessionClientDisabled,
    /// Every `user_code` candidate collided with an existing request.
    UserCodeExhausted,
    /// The store couldn't be read or written.
    Store(AuthorizationServerError),
}

impl From<AuthorizationServerError> for BrowserPairingStartError {
    fn from(error: AuthorizationServerError) -> Self {
        BrowserPairingStartError::Store(error)
    }
}

/// Where a pairing stands, as one poll found it.
#[derive(Debug)]
pub(crate) enum BrowserPairingStatus {
    /// The Owner hasn't decided yet.
    Pending,
    /// The page polled sooner than the poll interval allows; nothing was read
    /// or recorded.
    SlowDown,
    /// The Owner approved, and this poll started the approved session: its
    /// token, which the browser holds as its browser session cookie.
    Approved { session_token: String },
    /// The Owner declined.
    Denied,
    /// The request expired before the Owner approved it, or an earlier poll
    /// already started its session.
    Expired,
}

/// Why a poll answered nothing about the pairing.
#[derive(Debug)]
pub(crate) enum BrowserPairingPollError {
    /// No browser pairing has the presented pairing code.
    NotFound,
    /// The store couldn't be read or written.
    Store(AuthorizationServerError),
    /// The approved session couldn't be stored. The request is claimed.
    SessionNotStored(AuthorizationServerError),
    /// The session's token couldn't be minted. The request is claimed.
    Issuance(TokenIssuanceError),
}

impl From<AuthorizationServerError> for BrowserPairingPollError {
    fn from(error: AuthorizationServerError) -> Self {
        BrowserPairingPollError::Store(error)
    }
}

/// Start and poll browser pairings. Generic over the store port so it's
/// unit-testable against the fake; the binding instantiates it over the
/// concrete `SqliteGrantStore`.
pub(crate) struct BrowserPairing<S: GrantStore> {
    store: S,
    owner_approval: Arc<dyn OwnerApproval>,
    destinations: Arc<SignInDestinations>,
    /// The server's bare origin, the session token's `iss` and `aud`.
    server_origin: Arc<str>,
}

impl<S: GrantStore> BrowserPairing<S> {
    /// Build the pairing over the handles lifted from the state.
    pub(crate) fn new(
        store: S,
        owner_approval: Arc<dyn OwnerApproval>,
        destinations: Arc<SignInDestinations>,
        server_origin: Arc<str>,
    ) -> Self {
        BrowserPairing {
            store,
            owner_approval,
            destinations,
            server_origin,
        }
    }

    /// Start a pairing that goes on to `next` once approved, named
    /// `user_agent_name` (the name the browser's user agent suggests, if
    /// any), and republish the newest pending consent so the host notifies
    /// it. A `next` that isn't a path on this server, or a disabled
    /// browser-session client, starts nothing.
    ///
    /// # Errors
    ///
    /// [`BrowserPairingStartError::NextNotAllowed`],
    /// [`BrowserPairingStartError::BrowserSessionClientDisabled`],
    /// [`BrowserPairingStartError::UserCodeExhausted`], or a store failure.
    pub(crate) fn start(
        &self,
        next: &str,
        user_agent_name: Option<String>,
    ) -> Result<StartedBrowserPairing, BrowserPairingStartError> {
        let next = self
            .destinations
            .allow_on_this_server(next)
            .ok_or(BrowserPairingStartError::NextNotAllowed)?;
        if self.browser_session_client_is_disabled()? {
            return Err(BrowserPairingStartError::BrowserSessionClientDisabled);
        }
        // 256-bit CSPRNG opaque token, like a `device_code`.
        let pairing_code = generate_authorization_code();
        let user_code = generate_unique_user_code(&self.store)?
            .ok_or(BrowserPairingStartError::UserCodeExhausted)?;
        let browser_name = user_agent_name.unwrap_or_else(|| UNRECOGNIZED_BROWSER_NAME.to_owned());
        self.store
            .insert_authorization_request(&AuthorizationRequest::new_browser_pairing(
                StartBrowserPairingArgs {
                    id: pairing_code.clone(),
                    client_id: BROWSER_SESSION_CLIENT_ID.to_owned(),
                    requested_scopes: pairing_requested_scopes(),
                    user_code: user_code.clone(),
                    browser_name: browser_name.clone(),
                    ttl: DEVICE_AUTHORIZATION_TTL,
                },
            ))?;
        self.owner_approval.republish_active();
        Ok(StartedBrowserPairing {
            pairing_code,
            user_code,
            browser_name,
            next,
            expires_in: DEVICE_AUTHORIZATION_TTL.num_seconds(),
            interval: DEVICE_CODE_POLL_INTERVAL.num_seconds(),
        })
    }

    /// Poll the pairing `pairing_code` names at `now`, from a page that now
    /// names its browser `browser_name` (blank keeps the name it has). While
    /// it is pending the poll is stamped, throttled to the poll interval, and
    /// the name recorded; once approved, the first poll claims it, stores the
    /// approved session it starts, and mints the session's token.
    ///
    /// # Errors
    ///
    /// [`BrowserPairingPollError::NotFound`] when no pairing has the code; a
    /// store, session or minting failure.
    pub(crate) fn poll(
        &self,
        pairing_code: &str,
        browser_name: &str,
        now: DateTime<Utc>,
    ) -> Result<BrowserPairingStatus, BrowserPairingPollError> {
        let pairing_request = match self.store.authorization_request_by_id(pairing_code)? {
            Some(request) if request.grant_type == GrantType::BrowserPairing => request,
            _ => return Err(BrowserPairingPollError::NotFound),
        };
        if pairing_request.expires_at < now {
            return Ok(BrowserPairingStatus::Expired);
        }
        match pairing_request.status {
            RequestStatus::Pending => self.record_poll(&pairing_request, browser_name, now),
            RequestStatus::Approved => self.start_approved_session(&pairing_request, now),
            RequestStatus::Denied => Ok(BrowserPairingStatus::Denied),
            RequestStatus::Expired => Ok(BrowserPairingStatus::Expired),
        }
    }

    /// Throttle and stamp a poll of the pending `pairing_request`, recording
    /// `browser_name` when it is a new one, which the newest pending consent
    /// is republished for.
    fn record_poll(
        &self,
        pairing_request: &AuthorizationRequest,
        browser_name: &str,
        now: DateTime<Utc>,
    ) -> Result<BrowserPairingStatus, BrowserPairingPollError> {
        if pairing_request
            .last_polled_at
            .is_some_and(|last_polled_at| now - last_polled_at < DEVICE_CODE_POLL_INTERVAL)
        {
            return Ok(BrowserPairingStatus::SlowDown);
        }
        let browser_name = Some(browser_name.trim())
            .filter(|browser_name| !browser_name.is_empty())
            .or(pairing_request.device_name.as_deref())
            .unwrap_or(UNRECOGNIZED_BROWSER_NAME);
        self.store
            .record_browser_pairing_poll(&pairing_request.id, now, browser_name)?;
        if pairing_request.device_name.as_deref() != Some(browser_name) {
            self.owner_approval.republish_active();
        }
        Ok(BrowserPairingStatus::Pending)
    }

    /// Claim the approved `pairing_request`, store the approved session it
    /// starts, and mint the session's token. A request another poll claimed
    /// first is [`Expired`](BrowserPairingStatus::Expired).
    fn start_approved_session(
        &self,
        pairing_request: &AuthorizationRequest,
        now: DateTime<Utc>,
    ) -> Result<BrowserPairingStatus, BrowserPairingPollError> {
        let Some(claimed_pairing) =
            ClaimedBrowserPairing::claim(&self.store, pairing_request, APPROVED_SESSION_TTL, now)?
        else {
            return Ok(BrowserPairingStatus::Expired);
        };
        BrowserSessionWriter::over(&self.store)
            .start_approved_session(&claimed_pairing)
            .map_err(BrowserPairingPollError::SessionNotStored)?;
        let session_token =
            AccessTokenMinter::new(&self.store, &self.server_origin, APPROVED_SESSION_TTL)
                .mint(TokenEntitlement::BrowserPairing(&claimed_pairing))
                .map_err(BrowserPairingPollError::Issuance)?;
        Ok(BrowserPairingStatus::Approved { session_token })
    }

    /// Whether the browser-session client is disabled. Its row is seeded at
    /// boot, so a missing one is an error, not an enabled client.
    fn browser_session_client_is_disabled(&self) -> Result<bool, AuthorizationServerError> {
        let browser_session_client = self
            .store
            .client_by_id(BROWSER_SESSION_CLIENT_ID)?
            .ok_or_else(|| AuthorizationServerError::ClientNotFound {
                client_id: BROWSER_SESSION_CLIENT_ID.to_owned(),
            })?;
        Ok(browser_session_client.disabled_at.is_some())
    }
}

#[cfg(test)]
mod tests {
    use url::Url;
    use wildflowerhealthio_shared_structures::authorization_app::AuthorizationAppBase;
    use wildflowerhealthio_shared_structures::launcher::LauncherBase;

    use super::*;
    use crate::domain::browser_session::BrowserSessionKind;
    use crate::domain::test_fake::{
        client, seed_active_signing_key, FakeGrantStore, RecordingOwnerApproval,
    };
    use crate::domain::token::{verify_jwt, VerifyOptions};
    use crate::domain::GrantTx as _;

    const SERVER_ORIGIN: &str = "https://ruth.relay.example";
    const NEXT: &str = "/oauth/authorize?client_id=app&state=s";

    /// A pairing over a store with a signing key and the seeded
    /// browser-session client, and the approval port it republishes through.
    fn pairing() -> (
        BrowserPairing<FakeGrantStore>,
        Arc<RecordingOwnerApproval>,
        crate::domain::signing_key::SigningKey,
    ) {
        let store = FakeGrantStore::default();
        let signing_key = seed_active_signing_key(&store);
        store
            .upsert_client(&client(
                BROWSER_SESSION_CLIENT_ID,
                &["system/*.cruds", "wildflower/*.cruds", "wildflower/launch"],
            ))
            .expect("seed the browser-session client");
        let owner_approval = Arc::new(RecordingOwnerApproval::default());
        let pairing = BrowserPairing::new(
            store,
            owner_approval.clone(),
            Arc::new(SignInDestinations::new(
                Url::parse(SERVER_ORIGIN).expect("server origin"),
                LauncherBase::parse("https://site.example/launcher/").expect("launcher"),
                AuthorizationAppBase::parse("https://site.example/authorization/")
                    .expect("authorization app"),
                Url::parse("https://site.example/launcher/").expect("launcher URL"),
                Url::parse("https://site.example/authorization/").expect("authorization URL"),
            )),
            SERVER_ORIGIN.into(),
        );
        (pairing, owner_approval, signing_key)
    }

    /// Approve the pending pairing `user_code` names with `approved_scopes`,
    /// as the device page's approval does.
    fn approve(store: &FakeGrantStore, pairing_code: &str, approved_scopes: &[&str]) {
        let approved_scopes: Vec<String> = approved_scopes.iter().map(|&s| s.to_owned()).collect();
        assert!(store
            .with_connection(|tx| {
                tx.approve_authorization_request(
                    pairing_code,
                    &approved_scopes,
                    None,
                    Some("Ruth's laptop"),
                )
            })
            .expect("approve"));
    }

    /// A start parks a pending pairing for the browser-session client under
    /// its user code, named after the user agent, requesting the Owner's
    /// scopes, and raises the Owner's notification.
    #[test]
    fn a_start_parks_a_pending_pairing_and_notifies() {
        let (pairing, owner_approval, _) = pairing();
        let started = pairing
            .start(NEXT, Some("Firefox on Linux".to_owned()))
            .expect("starts");
        assert_eq!(started.next.location(), NEXT);
        assert_eq!(started.browser_name, "Firefox on Linux");
        assert_eq!(started.expires_in, DEVICE_AUTHORIZATION_TTL.num_seconds());
        assert_eq!(started.interval, DEVICE_CODE_POLL_INTERVAL.num_seconds());
        assert_ne!(started.pairing_code, started.user_code);
        let parked = pairing
            .store
            .authorization_request_by_user_code(&started.user_code)
            .unwrap()
            .expect("parked under its user code");
        assert_eq!(parked.id, started.pairing_code);
        assert_eq!(parked.grant_type, GrantType::BrowserPairing);
        assert_eq!(parked.client_id, BROWSER_SESSION_CLIENT_ID);
        assert_eq!(parked.status, RequestStatus::Pending);
        assert_eq!(parked.requested_scopes, crate::owner_scopes());
        assert_eq!(parked.device_name.as_deref(), Some("Firefox on Linux"));
        assert_eq!(owner_approval.count(), 1);
    }

    #[test]
    fn a_browser_its_user_agent_doesn_t_name_goes_by_a_generic_name() {
        let (pairing, _, _) = pairing();
        let started = pairing.start(NEXT, None).expect("starts");
        assert_eq!(started.browser_name, UNRECOGNIZED_BROWSER_NAME);
    }

    /// A `next` off this server, or a disabled browser-session client, parks
    /// nothing and notifies nobody.
    #[test]
    fn a_start_is_refused_for_a_foreign_next_or_a_disabled_client() {
        let (pairing, owner_approval, _) = pairing();
        for next in [
            "https://evil.example/",
            "//evil.example/",
            "",
            "oauth/authorize",
        ] {
            assert!(
                matches!(
                    pairing.start(next, None),
                    Err(BrowserPairingStartError::NextNotAllowed)
                ),
                "{next:?}"
            );
        }
        assert!(pairing
            .store
            .set_client_disabled(BROWSER_SESSION_CLIENT_ID, Some(Utc::now()))
            .unwrap());
        assert!(matches!(
            pairing.start(NEXT, None),
            Err(BrowserPairingStartError::BrowserSessionClientDisabled)
        ));
        assert_eq!(owner_approval.count(), 0);
    }

    /// While pending, a poll is throttled to the interval, records the name
    /// the page now gives (blank keeps the last one), and republishes only
    /// for a new name.
    #[test]
    fn a_pending_poll_is_throttled_and_records_the_browser_s_name() {
        let (pairing, owner_approval, _) = pairing();
        let started = pairing
            .start(NEXT, Some("Firefox on Linux".to_owned()))
            .unwrap();
        let now = Utc::now();
        let poll = |name: &str, at| pairing.poll(&started.pairing_code, name, at).unwrap();
        let name = || {
            pairing
                .store
                .authorization_request_by_id(&started.pairing_code)
                .unwrap()
                .unwrap()
                .device_name
        };
        assert!(matches!(
            poll("Firefox on Linux", now),
            BrowserPairingStatus::Pending
        ));
        assert_eq!(
            owner_approval.count(),
            1,
            "the same name republishes nothing"
        );
        assert!(matches!(
            poll("Kitchen laptop", now + Duration::seconds(1)),
            BrowserPairingStatus::SlowDown
        ));
        assert_eq!(name().as_deref(), Some("Firefox on Linux"));
        let later = now + DEVICE_CODE_POLL_INTERVAL;
        assert!(matches!(
            poll("  Kitchen laptop ", later),
            BrowserPairingStatus::Pending
        ));
        assert_eq!(name().as_deref(), Some("Kitchen laptop"));
        assert_eq!(owner_approval.count(), 2);
        assert!(matches!(
            poll(" ", later + DEVICE_CODE_POLL_INTERVAL),
            BrowserPairingStatus::Pending
        ));
        assert_eq!(name().as_deref(), Some("Kitchen laptop"));
    }

    /// Once approved, the first poll starts a 24 h approved session holding
    /// exactly the approved scopes, under the name the Owner approved, and
    /// mints its token for the browser-session client; the next poll finds it
    /// spent.
    #[test]
    fn the_first_poll_after_approval_starts_the_approved_session() {
        let (pairing, _, signing_key) = pairing();
        let started = pairing.start(NEXT, None).unwrap();
        approve(
            &pairing.store,
            &started.pairing_code,
            &["wildflower/launch", "system/Patient.rs"],
        );
        let now = Utc::now();
        let BrowserPairingStatus::Approved { session_token } = pairing
            .poll(&started.pairing_code, "ignored once approved", now)
            .unwrap()
        else {
            panic!("approved");
        };
        let claims = verify_jwt(
            &session_token,
            &[signing_key],
            &VerifyOptions {
                expected_issuer: SERVER_ORIGIN,
                accepted_audiences: &[SERVER_ORIGIN.to_owned()],
            },
        )
        .expect("a token this server accepts");
        assert_eq!(claims.subject, BROWSER_SESSION_CLIENT_ID);
        assert_eq!(
            claims.scope.as_deref(),
            Some("wildflower/launch system/Patient.rs")
        );
        assert_eq!(
            claims
                .expires_at
                .zip(claims.issued_at)
                .map(|(exp, iat)| exp - iat),
            Some(APPROVED_SESSION_TTL)
        );
        let sid = claims.sid.expect("names its session");
        let session = pairing
            .store
            .browser_session_by_sid(&sid)
            .unwrap()
            .expect("the session is stored");
        assert_eq!(session.kind, BrowserSessionKind::Approved);
        assert_eq!(session.name.as_deref(), Some("Ruth's laptop"));
        assert_eq!(session.scopes, ["wildflower/launch", "system/Patient.rs"]);
        assert_eq!(
            session.expires_at - session.created_at,
            APPROVED_SESSION_TTL
        );
        assert!(matches!(
            pairing.poll(&started.pairing_code, "", now).unwrap(),
            BrowserPairingStatus::Expired
        ));
    }

    /// A denied pairing says so; an expired one says so, even once approved;
    /// an unknown code, or another flow's request, is not found.
    #[test]
    fn denied_expired_and_unknown_pairings_start_no_session() {
        let (pairing, _, _) = pairing();
        let denied = pairing.start(NEXT, None).unwrap();
        pairing
            .store
            .deny_authorization_request(&denied.pairing_code)
            .unwrap();
        assert!(matches!(
            pairing.poll(&denied.pairing_code, "", Utc::now()).unwrap(),
            BrowserPairingStatus::Denied
        ));
        let approved_too_late = pairing.start(NEXT, None).unwrap();
        approve(
            &pairing.store,
            &approved_too_late.pairing_code,
            &["wildflower/launch"],
        );
        assert!(matches!(
            pairing
                .poll(
                    &approved_too_late.pairing_code,
                    "",
                    Utc::now() + DEVICE_AUTHORIZATION_TTL + Duration::seconds(1)
                )
                .unwrap(),
            BrowserPairingStatus::Expired
        ));
        assert!(matches!(
            pairing.poll("no-such-code", "", Utc::now()),
            Err(BrowserPairingPollError::NotFound)
        ));
        pairing
            .store
            .insert_authorization_request(&crate::domain::test_fake::device_request(
                "a-device-code",
                "DEVI-CE00",
                RequestStatus::Approved,
            ))
            .unwrap();
        assert!(matches!(
            pairing.poll("a-device-code", "", Utc::now()),
            Err(BrowserPairingPollError::NotFound)
        ));
    }
}
