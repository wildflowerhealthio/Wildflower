//! The composition layer — where the generic, store-agnostic capabilities in
//! [`crate::domain::capabilities`] meet the concrete [`SqliteGatekeeperStore`](crate::db::SqliteGatekeeperStore)
//! and the `Arc<GatekeeperState>` router state. It lives at the crate root (not
//! under [`crate::http`]) so `domain/` can be built from it without depending on
//! the transport layer.
//!
//! - [`state`] holds the [`GatekeeperState`](state::GatekeeperState) struct.
//! - [`crate::adapters`] holds the port trait impls that adapt the state /
//!   revocation store to the domain seams.
//! - [`FromState`] is how a capability that no principal unlocks (the
//!   pre-auth front door, the token verifier) is built: the `Live<F>` extractor
//!   in `http` calls it, so a handler never names the state itself.
//! - The remaining modules hold one binding each (the `/access` ones implement
//!   `FixedScopeCapability`/`Capability`, the session ones
//!   `AuthenticatedCapability`); each lifts the store + port handles out of the
//!   state (never the whole state), so `domain/` stays free of both
//!   `crate::http` and the concrete adapter types. The `Live…` aliases are what
//!   the handlers name in `Scoped<…>`, `Authenticated<…>`, or `Live<…>`.

mod client_authenticator;
mod consents_decider;
mod consents_reader;
mod grants_reader;
mod grants_revoker;
mod oauth_front_door;
mod session;

pub mod state;
mod token_exchanger;
mod token_revoker;

pub(crate) use client_authenticator::LiveClientAuthenticator;
pub(crate) use consents_decider::LiveConsentDecider;
pub(crate) use consents_reader::LiveConsentReader;
pub(crate) use grants_reader::LiveGrantsReader;
pub(crate) use grants_revoker::LiveGrantsRevoker;
pub(crate) use oauth_front_door::{
    LiveAuthorizationStatusReader, LiveCodeAuthorizationStarter, LiveDeviceAuthorizer,
    LivePublicKeysReader,
};
pub(crate) use session::{LiveSessionEnder, LiveSessionReader, LiveTokenVerifier};
pub use state::GatekeeperState;
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
    fn from_state(state: &std::sync::Arc<GatekeeperState>) -> Self;
}
