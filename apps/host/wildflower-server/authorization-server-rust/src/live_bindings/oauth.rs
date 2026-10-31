//! The `/oauth` bindings: the pre-auth front door over the concrete
//! `SqliteGrantStore` — the capabilities handlers acquire through `Live<…>`
//! ([`FromState`]), whose gate, where they have one, is the proof their
//! methods take — and the in-process minters and watcher
//! [`crate::setup_authorization_server`] hands the host and the other slices.

use std::sync::Arc;

use chrono::Utc;
use tokio::sync::watch;

use super::state::AuthorizationServerState;
use super::FromState;
use crate::crypto_util::random_token::{generate_launch_nonce, generate_same_device_sign_in_code};
use crate::db::SqliteGrantStore;
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::capabilities::oauth::{
    AuthorizationStatusReader, BrowserPairing, ClientAuthenticator, ClientTokenRevoker,
    CodeAuthorizationStarter, DeviceAuthorizer, LaunchContexts, PublicKeysReader,
    SameDeviceSessionEnder, SameDeviceSignIn, SessionShortfall, TokenExchanger,
};
use crate::domain::consent_key::ConsentKey;
use crate::domain::grant_store::AuthorizationRequestsTx as _;
use crate::domain::same_device_sign_in_codes::{SameDeviceSignInCode, SameDeviceSignInCodes};
use crate::domain::GrantStore as _;
use crate::ports::OwnerApproval;

/// Start an authorization-code flow — built by the `/oauth/authorize` handler
/// and by the limited page's `/oauth/authorize/{id}/continue`. Takes the
/// [`OwnerApproval`] port, since a request it parks is one the Owner must hear
/// about, the server's origin and the stale-session cutoff.
pub(crate) type LiveCodeAuthorizationStarter = CodeAuthorizationStarter<SqliteGrantStore>;

impl FromState for LiveCodeAuthorizationStarter {
    fn from_state(state: &Arc<AuthorizationServerState>) -> Self {
        let owner_approval: Arc<dyn OwnerApproval> = state.clone();
        CodeAuthorizationStarter::new(
            state.store.clone(),
            owner_approval,
            state.server_origin.clone(),
            state.stale_session_cutoff.clone(),
        )
    }
}

/// Sign a browser in as the Owner with a code the base minted — built by the
/// `/oauth/sign-in` handler. Takes the outstanding sign-in codes, where a
/// browser may be sent next, the server's origin and the Owner's grant.
pub(crate) type LiveSameDeviceSignIn = SameDeviceSignIn<SqliteGrantStore>;

impl FromState for LiveSameDeviceSignIn {
    fn from_state(state: &Arc<AuthorizationServerState>) -> Self {
        SameDeviceSignIn::new(
            state.store.clone(),
            state.same_device_sign_in_codes.clone(),
            state.sign_in_destinations.clone(),
            state.server_origin.clone(),
            state.owner_grant.clone(),
        )
    }
}

/// Read and cancel a request waiting on its browser's limited page — built by
/// the `/oauth/authorize/{id}/session-shortfall` and `/cancel` handlers. Takes
/// the stale-session cutoff beside the store.
pub(crate) type LiveSessionShortfall = SessionShortfall<SqliteGrantStore>;

impl FromState for LiveSessionShortfall {
    fn from_state(state: &Arc<AuthorizationServerState>) -> Self {
        SessionShortfall::new(state.store.clone(), state.stale_session_cutoff.clone())
    }
}

/// Start and poll browser pairings — built by the `/oauth/pair/*` handlers.
/// Takes the [`OwnerApproval`] port, since a pairing is a request the Owner
/// must hear about, where a paired browser may be sent next, and the server's
/// origin.
pub(crate) type LiveBrowserPairing = BrowserPairing<SqliteGrantStore>;

impl FromState for LiveBrowserPairing {
    fn from_state(state: &Arc<AuthorizationServerState>) -> Self {
        let owner_approval: Arc<dyn OwnerApproval> = state.clone();
        BrowserPairing::new(
            state.store.clone(),
            owner_approval,
            state.sign_in_destinations.clone(),
            state.server_origin.clone(),
        )
    }
}

/// Start a device authorization — built by the `/oauth/device_authorization`
/// handler. Takes the [`OwnerApproval`] port, since a device request is one the
/// Owner must hear about, and the device page's URL it hands out.
pub(crate) type LiveDeviceAuthorizer = DeviceAuthorizer<SqliteGrantStore>;

impl FromState for LiveDeviceAuthorizer {
    fn from_state(state: &Arc<AuthorizationServerState>) -> Self {
        let owner_approval: Arc<dyn OwnerApproval> = state.clone();
        DeviceAuthorizer::new(
            state.store.clone(),
            owner_approval,
            state.device_page.clone(),
        )
    }
}

/// Poll an authorization request — built by the `/oauth/authorize/{id}`
/// handler, the wait page's status poll. Takes nothing beside the store.
pub(crate) type LiveAuthorizationStatusReader = AuthorizationStatusReader<SqliteGrantStore>;

impl FromState for LiveAuthorizationStatusReader {
    fn from_state(state: &Arc<AuthorizationServerState>) -> Self {
        AuthorizationStatusReader::new(state.store.clone())
    }
}

/// Serve the public signing keys — built by the `/.well-known/jwks.json`
/// handler. Takes nothing beside the store.
pub(crate) type LivePublicKeysReader = PublicKeysReader<SqliteGrantStore>;

impl FromState for LivePublicKeysReader {
    fn from_state(state: &Arc<AuthorizationServerState>) -> Self {
        PublicKeysReader::new(state.store.clone())
    }
}

/// Authenticate a client's presented credentials — built by the `TokenRequest`
/// extractor for `/oauth/token` and `/oauth/device_authorization`. Takes
/// nothing beside the store.
pub(crate) type LiveClientAuthenticator = ClientAuthenticator<SqliteGrantStore>;

impl FromState for LiveClientAuthenticator {
    fn from_state(state: &Arc<AuthorizationServerState>) -> Self {
        ClientAuthenticator::new(state.store.clone())
    }
}

/// Exchange grants for tokens — built by the `/oauth/token` handler. Takes the
/// revocation check, which refresh redemption asks, and the server's origin.
pub(crate) type LiveTokenExchanger = TokenExchanger<SqliteGrantStore>;

impl FromState for LiveTokenExchanger {
    fn from_state(state: &Arc<AuthorizationServerState>) -> Self {
        TokenExchanger::new(
            state.store.clone(),
            state.revocation_check(),
            state.server_origin.clone(),
        )
    }
}

/// Revoke a client's own tokens — built by the `/oauth/revoke` handler. Takes
/// the [`Revocation`](crate::ports::Revocation) port it denylists through, and
/// the server's origin.
pub(crate) type LiveClientTokenRevoker = ClientTokenRevoker<SqliteGrantStore>;

impl FromState for LiveClientTokenRevoker {
    fn from_state(state: &Arc<AuthorizationServerState>) -> Self {
        ClientTokenRevoker::new(
            state.store.clone(),
            state.revocation(),
            state.server_origin.clone(),
        )
    }
}

/// Mint SMART App Launch contexts: how the host's own launchers start a SMART
/// app launch. An app launched from a launcher gets a `launch` value in its
/// URL, which it hands to `/oauth/authorize`; the launch context it names is
/// minted here, in-process. Cheap to clone (the store wraps a pool).
/// [`crate::setup_authorization_server`] hands one out on
/// [`AuthorizationServer::launch_context_minter`](crate::AuthorizationServer::launch_context_minter).
#[derive(Clone)]
pub struct LaunchContextMinter {
    /// The launch-context capability over the server's store, which mints and
    /// stores each context.
    launch_contexts: LaunchContexts<SqliteGrantStore>,
}

impl LaunchContextMinter {
    /// A minter over the authorization server's store.
    pub(crate) fn new(store: SqliteGrantStore) -> Self {
        LaunchContextMinter {
            launch_contexts: LaunchContexts::new(store),
        }
    }

    /// Mint a launch for the OAuth client `client_id` and return its `launch`
    /// value, to put in the app's launch URL. It binds no patient, expires five
    /// minutes from now, and works for one `/oauth/authorize` by that client.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] on a store failure.
    pub fn mint(&self, client_id: &str) -> Result<String, AuthorizationServerError> {
        self.launch_contexts
            .mint(client_id, generate_launch_nonce(), Utc::now())
            .map(|launch_context| launch_context.nonce)
    }

    /// Mint a launch for the base's launch of a server's launcher and return
    /// its `launch` value. Any OAuth client may consume it: the launcher can
    /// be any app the Owner set, so the base can't name its client. It binds
    /// no patient, expires five minutes from now, and works for one
    /// `/oauth/authorize`, by whichever client presents it first.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] on a store failure.
    pub fn mint_for_server_launcher(&self) -> Result<String, AuthorizationServerError> {
        self.launch_contexts
            .mint_for_server_launcher(generate_launch_nonce(), Utc::now())
            .map(|launch_context| launch_context.nonce)
    }
}

/// Mint one-time same-device sign-in codes: how the host signs the Owner's own
/// browser in. The host, on the device running the server, mints a code and
/// opens `/oauth/sign-in?code=…&next=…` in the browser. It also ends the
/// sessions codes signed in, once the views they were opened in have closed.
/// Cheap to clone (the codes and the store are shared).
/// [`crate::setup_authorization_server`] hands one out on
/// [`AuthorizationServer::same_device_sign_in_code_minter`](crate::AuthorizationServer::same_device_sign_in_code_minter).
#[derive(Clone)]
pub struct SameDeviceSignInCodeMinter {
    /// The outstanding codes, shared with the server's state, where
    /// `/oauth/sign-in` redeems them.
    codes: Arc<SameDeviceSignInCodes>,
    /// The store, where the sessions codes signed in are ended.
    store: SqliteGrantStore,
}

impl SameDeviceSignInCodeMinter {
    /// A minter over the authorization server's outstanding codes, and its
    /// `store`, where the sessions codes signed in are ended.
    pub(crate) fn new(codes: Arc<SameDeviceSignInCodes>, store: SqliteGrantStore) -> Self {
        SameDeviceSignInCodeMinter { codes, store }
    }

    /// Mint a sign-in code and return it, for the `code` of
    /// `/oauth/sign-in?code=…&next=…`: the first browser to present it, within
    /// 60 seconds, is signed in as the Owner. Only its hash is kept, in
    /// memory, so a restart drops it.
    #[must_use]
    pub fn mint(&self) -> SameDeviceSignInCode {
        let code = generate_same_device_sign_in_code();
        self.codes.insert(&code, Utc::now());
        SameDeviceSignInCode::new(code, Arc::clone(&self.codes))
    }

    /// Withdraw `sign_in_codes`, and end the sessions they signed browsers
    /// in with, by expiring them now in this run's store, whichever run
    /// minted the codes: those browsers' cookies stop working, and they are
    /// sent through sign-in again. Returns how many sessions were ended; a
    /// code that signed nobody in, or whose session was ended already, ends
    /// nothing. A failure leaves each code holding its session, so ending
    /// them can be tried again. It writes to the database, so call it on a
    /// blocking thread.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] on a store failure.
    pub fn end_signed_in_sessions(
        &self,
        sign_in_codes: &[SameDeviceSignInCode],
    ) -> Result<usize, AuthorizationServerError> {
        SameDeviceSessionEnder::new(self.store.clone())
            .end_sessions_signed_in_with(sign_in_codes, Utc::now())
    }
}

/// Watches whether a pending consent still waits for the Owner. Cheap to
/// clone. [`crate::setup_authorization_server`] hands one out on
/// [`AuthorizationServer::pending_consent_watcher`](crate::AuthorizationServer::pending_consent_watcher).
///
/// It rereads the request each time the authorization server recomputes its
/// [`OwnerPrompt`](crate::OwnerPrompt): after every transition that may change
/// which requests are pending (a new request, an approve or a deny), and on the
/// reaper's tick, which is how an expiry is noticed. Each recompute is
/// signalled whether or not the prompt changed, so a request decided while a
/// newer one stays newest is still seen to settle.
#[derive(Clone)]
pub struct PendingConsentWatcher {
    /// The server's store, which each reread of the watched request reads.
    store: SqliteGrantStore,
    /// Woken on every recompute of the Owner prompt; the watcher rereads its
    /// request on each wake.
    pending_consents_recomputed_rx: watch::Receiver<()>,
}

impl PendingConsentWatcher {
    /// A watcher over the authorization server's `store`, woken through
    /// `pending_consents_recomputed_rx`.
    pub(crate) fn new(
        store: SqliteGrantStore,
        pending_consents_recomputed_rx: watch::Receiver<()>,
    ) -> Self {
        PendingConsentWatcher {
            store,
            pending_consents_recomputed_rx,
        }
    }

    /// Wait until the request `consent` names no longer waits for the Owner:
    /// decided, expired, or gone. Answers at once for one that already
    /// doesn't. Each read
    /// ([`is_awaiting_owner`](crate::domain::grant_store::AuthorizationRequestsTx::is_awaiting_owner))
    /// runs on a blocking thread.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] when reading the request
    /// fails, or when the authorization server stops before the request
    /// settles.
    pub async fn until_settled(&self, consent: ConsentKey) -> Result<(), AuthorizationServerError> {
        let mut pending_consents_recomputed_rx = self.pending_consents_recomputed_rx.clone();
        loop {
            pending_consents_recomputed_rx.borrow_and_update();
            let store = self.store.clone();
            let read_consent = consent.clone();
            let pending = tokio::task::spawn_blocking(move || {
                store.read(|tx| tx.is_awaiting_owner(&read_consent, Utc::now()))
            })
            .await
            .map_err(|error| {
                AuthorizationServerError::infrastructure("reading a pending consent", error)
            })??;
            if !pending {
                return Ok(());
            }
            if pending_consents_recomputed_rx.changed().await.is_err() {
                return Err(AuthorizationServerError::infrastructure(
                    "watching a pending consent",
                    "the authorization server stopped",
                ));
            }
        }
    }
}
