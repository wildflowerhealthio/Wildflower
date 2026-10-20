//! The authorization server's persistence **port**.
//!
//! - [`GrantStore`] is the seam a capability opens its one scope through: a
//!   [`read`](GrantStore::read) scope (autocommit) for an operation that only
//!   reads, a [`write`](GrantStore::write) scope (`BEGIN IMMEDIATE`) for one
//!   that writes.
//! - [`GrantTx`] is what a scope hands out: every primitive the domain needs
//!   (one statement, or a few that land together in the scope), one trait per
//!   table it touches ([`ClientsTx`], [`SigningKeysTx`],
//!   [`AuthorizationRequestsTx`], [`AuthorizationCodesTx`],
//!   [`LaunchContextsTx`], [`BrowserSessionsTx`], [`RefreshTokensTx`],
//!   [`GrantsTx`]), bundled. A primitive reports absence and conflict through
//!   its return type (`Option`, `bool`) and fails only with the opaque
//!   [`Infrastructure`](crate::domain::authorization_server_error::AuthorizationServerError::Infrastructure)
//!   error; what an outcome means is decided in `domain::capabilities`.
//!
//! A capability method reads as: open the scope, run the flow inside it to an
//! outcome value, then act on the outcome outside it. What acts outside is a
//! side effect: republishing the newest pending consent, and writing to
//! another store (the revocation store's epochs). A side effect inside the
//! scope would run before the commit: a republish reads the store on another
//! pooled connection, which can't see this scope's uncommitted writes and
//! would read the rows as they stood before it. Signing a token is not a side effect — it is pure
//! computation over the key the scope loaded — so it runs inside the scope,
//! and a signing failure rolls the scope back.
//!
//! The `SQLite` adapter is `crate::db`'s `SqliteGrantStore`, which implements
//! each concern trait in that concern's `db/` file; the in-memory
//! `FakeGrantStore` stands in for it in the domain's unit tests.

mod authorization_codes;
mod authorization_requests;
mod browser_sessions;
mod clients;
mod grants;
mod launch_contexts;
mod refresh_tokens;
mod signing_keys;
mod store;

pub use authorization_codes::AuthorizationCodesTx;
pub use authorization_requests::{write_transition, AuthorizationRequestsTx};
pub use browser_sessions::BrowserSessionsTx;
pub use clients::ClientsTx;
pub use grants::GrantsTx;
pub use launch_contexts::LaunchContextsTx;
pub use refresh_tokens::RefreshTokensTx;
pub use signing_keys::SigningKeysTx;
pub use store::GrantStore;

/// Every per-table primitive, on one connection-scoped handle: what a
/// [`GrantStore`] scope hands its closure. Implemented for any type that
/// implements every concern trait.
pub trait GrantTx:
    ClientsTx
    + SigningKeysTx
    + AuthorizationRequestsTx
    + AuthorizationCodesTx
    + LaunchContextsTx
    + BrowserSessionsTx
    + RefreshTokensTx
    + GrantsTx
{
}

impl<T> GrantTx for T where
    T: ClientsTx
        + SigningKeysTx
        + AuthorizationRequestsTx
        + AuthorizationCodesTx
        + LaunchContextsTx
        + BrowserSessionsTx
        + RefreshTokensTx
        + GrantsTx
{
}
