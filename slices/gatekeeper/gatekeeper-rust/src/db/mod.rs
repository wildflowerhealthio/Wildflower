//! SQLite persistence for the gatekeeper — one file per table, each
//! holding the row mappings and the `GatekeeperStore` query methods for
//! that table's [`crate::domain`] type. The store itself, the connection
//! wrapper, and the migration runner live next door in
//! [`crate::db_utils`].

mod authorization_codes;
mod authorization_requests;
mod clients;
mod grants;
mod local_client_token;
mod signing_keys;

pub use crate::db_utils::connection::DbResult;
pub use crate::db_utils::gatekeeper_store::GatekeeperStore;
