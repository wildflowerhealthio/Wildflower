//! The composition layer — where the generic, store-agnostic capabilities in
//! [`crate::domain::capabilities`] meet the concrete [`SqliteGrantStore`](crate::db::SqliteGrantStore)
//! and the `Arc<AuthorizationServerState>` router state. It lives at the crate root (not
//! under [`crate::http`]) so `domain/` can be built from it without depending on
//! the transport layer.
//!
//! - [`state`] holds the [`AuthorizationServerState`](state::AuthorizationServerState) struct.
//! - [`crate::adapters`] holds the port trait impls that adapt the state /
//!   revocation store to the domain seams.
//! - [`FromState`] is how a capability that no principal unlocks (the
//!   pre-auth front door, the token verifier) is built: the `Live<F>` extractor
//!   in `http` calls it, so a handler never names the state itself.
//! - [`LaunchContextMinter`] is the mint-only face of the launch-context
//!   capability, handed out by [`crate::setup_authorization_server`] to the in-process
//!   launchers outside the authorization server.
//! - [`SameDeviceSignInCodeMinter`] is the in-process mint of the one-time codes
//!   `/oauth/sign-in` signs a browser in as the Owner with, handed out the
//!   same way, to the host.
//! - [`PendingConsentWatcher`] waits for one pending consent to be decided or
//!   expire, handed out the same way, to the host, which closes the page it
//!   opened the request at.
//! - [`InProcessTokenVerifier`] is the token verifier both authN gates run,
//!   handed out the same way, for the host's FHIR server to verify bearers
//!   with in-process.
//! - The remaining modules hold one binding each (the `/authorization` ones implement
//!   `FixedScopeCapability`/`Capability`, the session ones
//!   `AuthenticatedCapability`); each lifts the store + port handles out of the
//!   state (never the whole state), so `domain/` stays free of both
//!   `crate::http` and the concrete adapter types. The `Live…` aliases are what
//!   the handlers name in `Scoped<…>`, `Authenticated<…>`, or `Live<…>`.

mod client_authenticator;
mod clients_disabler;
mod clients_reader;
mod consents_decider;
mod consents_raiser;
mod consents_reader;
mod grants_reader;
mod grants_revoker;
mod in_process_token_verifier;
mod launch_context_minter;
mod oauth_front_door;
mod pending_consent_watcher;
mod same_device_sign_in_code_minter;
mod session;

pub mod state;
mod token_exchanger;
mod token_revoker;

pub(crate) use client_authenticator::LiveClientAuthenticator;
pub(crate) use clients_disabler::LiveClientsDisabler;
pub(crate) use clients_reader::LiveClientsReader;
pub(crate) use consents_decider::LiveConsentDecider;
pub(crate) use consents_raiser::LiveConsentRaiser;
pub(crate) use consents_reader::LiveConsentReader;
pub(crate) use grants_reader::LiveGrantsReader;
pub(crate) use grants_revoker::LiveGrantsRevoker;
pub use in_process_token_verifier::InProcessTokenVerifier;
pub use launch_context_minter::LaunchContextMinter;
pub(crate) use oauth_front_door::{
    LiveAuthorizationStatusReader, LiveBrowserPairing, LiveCodeAuthorizationStarter,
    LiveDeviceAuthorizer, LivePublicKeysReader, LiveSameDeviceSignIn,
};
pub use pending_consent_watcher::PendingConsentWatcher;
pub use same_device_sign_in_code_minter::SameDeviceSignInCodeMinter;
pub(crate) use session::{LiveSessionEnder, LiveSessionReader, LiveTokenVerifier};
pub use state::AuthorizationServerState;
pub(crate) use token_exchanger::LiveTokenExchanger;
pub(crate) use token_revoker::LiveTokenRevoker;

/// A live capability built from the router state alone — the pre-auth
/// front-door bindings and the token verifier, which no claims unlock (their
/// gate, where they have one, is the proof their methods take). Handlers
/// acquire them through the `Live<F>` extractor in `http`, so they never name
/// the state; the auth middleware and the token-request extractor build theirs
/// directly.
pub(crate) trait FromState {
    /// Lift the handles this capability needs out of the state.
    fn from_state(state: &std::sync::Arc<AuthorizationServerState>) -> Self;
}
