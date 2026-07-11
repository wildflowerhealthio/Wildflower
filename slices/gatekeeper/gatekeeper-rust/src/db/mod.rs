//! `SQLite` persistence for the gatekeeper — the [`GatekeeperStore`] handle
//! (Diesel over the app-wide r2d2 connection pool,
//! `persistence_rust::DieselPool`, mirroring collector's `RemotesStore`) plus
//! one file per table holding that table's `GatekeeperStore` query methods for
//! its [`crate::domain`] type. The store embeds and applies the gatekeeper
//! migrations on construction; [`columns`] maps the JSON/URL/enum TEXT columns
//! at the diesel bind/read boundary, and [`schema`] holds the `table!`
//! definitions (including the cross-kind `grants` VIEW).

mod authorization_codes;
mod authorization_requests;
mod clients;
pub(crate) mod columns;
mod gatekeeper_store;
mod grants;
mod refresh_tokens;
pub(crate) mod schema;
mod signing_keys;
#[cfg(test)]
mod test_support;

pub use gatekeeper_store::GatekeeperStore;
pub use refresh_tokens::RefreshTokenConsumeOutcome;
