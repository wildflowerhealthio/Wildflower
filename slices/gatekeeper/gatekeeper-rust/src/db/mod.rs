//! `SQLite` persistence for the gatekeeper — one file per table, each
//! holding the row mappings and the `GatekeeperStore` query methods for
//! that table's [`crate::domain`] type. The store itself, the connection
//! wrapper, and the migration runner live next door in
//! [`crate::db_utils`].

mod authorization_codes;
mod authorization_requests;
mod clients;
mod grants;
mod refresh_tokens;
mod signing_keys;
#[cfg(test)]
mod test_support;

pub use refresh_tokens::RefreshTokenConsumeOutcome;
