//! The composition layer — where the generic, store-agnostic capabilities in
//! [`crate::domain::capabilities`] meet the concrete [`SqliteGrantStore`](crate::db::SqliteGrantStore)
//! and the `Arc<AuthorizationServerState>` router state. It lives at the crate root (not
//! under [`crate::http`]) so `domain/` can be built from it without depending on
//! the transport layer.
//!
//! - [`state`] holds the [`AuthorizationServerState`](state::AuthorizationServerState) struct.
//! - [`crate::adapters`] holds the port trait impls that adapt the state /
//!   revocation store to the domain seams.
//! - `access` binds the scope-gated `/authorization` capabilities
//!   (`FixedScopeCapability` / `Capability`), acquired through `Scoped<…>`.
//! - `oauth` binds the pre-auth `/oauth` front door ([`FromState`], acquired
//!   through `Live<…>`), and holds the in-process faces
//!   [`crate::setup_authorization_server`] hands out: the
//!   [`LaunchContextMinter`] (the launchers outside the authorization server
//!   mint launches through it), the [`SameDeviceSignInCodeMinter`] (the host
//!   mints `/oauth/sign-in` codes through it) and the
//!   [`PendingConsentWatcher`] (the host waits on a consent through it).
//! - `session` binds the token verifier both authN gates run (and its
//!   in-process face, the [`InProcessTokenVerifier`] the host's FHIR server
//!   verifies bearers with) and the caller's-own-session capabilities
//!   (`AuthenticatedCapability`, acquired through `Authenticated<…>`).
//!
//! Each binding lifts the store and port handles out of the state (never the
//! whole state), so `domain/` stays free of both `crate::http` and the
//! concrete adapter types. The `Live…` aliases are what the handlers name in
//! `Scoped<…>`, `Authenticated<…>`, or `Live<…>`.

mod access;
mod oauth;
mod session;
pub mod state;

pub(crate) use access::{
    LiveBrowserSessionsReader, LiveBrowserSessionsRevoker, LiveClientsDisabler, LiveClientsReader,
    LiveConsentDecider, LiveConsentRaiser, LiveConsentReader, LiveGrantsReader, LiveGrantsRevoker,
    LiveTokenRevoker,
};
pub use oauth::{LaunchContextMinter, PendingConsentWatcher, SameDeviceSignInCodeMinter};
pub(crate) use oauth::{
    LiveAuthorizationStatusReader, LiveBrowserPairing, LiveClientAuthenticator,
    LiveClientTokenRevoker, LiveCodeAuthorizationStarter, LiveDeviceAuthorizer,
    LivePublicKeysReader, LiveSameDeviceSignIn, LiveSessionShortfall, LiveTokenExchanger,
};
pub use session::InProcessTokenVerifier;
pub(crate) use session::{
    LiveBrowserSessionEnder, LiveBrowserSessionUseRecorder, LiveSessionEnder, LiveSessionReader,
    LiveTokenVerifier,
};
pub use state::AuthorizationServerState;

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
