//! The composition layer — where the generic, store-agnostic capabilities in
//! [`crate::domain::capabilities`] meet the concrete [`SqliteGatekeeperStore`](crate::db::SqliteGatekeeperStore)
//! and the `Arc<GatekeeperState>` router state. It lives at the crate root (not
//! under [`crate::http`]) so `domain/` can be built from it without depending on
//! the transport layer.
//!
//! - [`state`] holds the [`GatekeeperState`](state::GatekeeperState) struct.
//! - [`crate::adapters`] holds the port trait impls that adapt the state /
//!   revocation store to the domain seams.
//! - [`grants`], [`consents`], and [`tokens`] hold the per-resource
//!   `FixedScopeCapability`/`Capability` bindings; each lifts the store + port
//!   handles out of the state (never the whole state), so `domain/` stays free of
//!   both `crate::http` and the concrete adapter types. The `Live…` aliases are
//!   what the `/access` handlers name in `Scoped<…>`.

mod client_authenticator;
mod consents_decider;
mod consents_reader;
mod grants_reader;
mod grants_revoker;
mod oauth_front_door;

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
};
pub use state::GatekeeperState;
pub(crate) use token_exchanger::LiveTokenExchanger;
pub(crate) use token_revoker::LiveTokenRevoker;
