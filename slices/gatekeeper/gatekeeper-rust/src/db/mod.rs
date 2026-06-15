//! `SQLite` persistence for the gatekeeper — the [`GatekeeperStore`] handle
//! (which wraps the shared connection and applies the gatekeeper migrations)
//! plus one file per table holding that table's row mappings and
//! `GatekeeperStore` query methods for its [`crate::domain`] type. The generic
//! connection wrapper and migration runner live in `persistence-rust`.

mod authorization_codes;
mod authorization_requests;
mod clients;
mod gatekeeper_store;
mod grants;
mod refresh_tokens;
mod signing_keys;
#[cfg(test)]
mod test_support;

pub use gatekeeper_store::GatekeeperStore;
pub use refresh_tokens::RefreshTokenConsumeOutcome;
