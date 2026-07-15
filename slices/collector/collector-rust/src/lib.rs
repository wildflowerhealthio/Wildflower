//! `collector-rust` — the host-side collector slice: SQLite-backed CRUD for
//! user-created remotes, serving the `/collector/remotes` HTTP surface defined
//! TS-side in `collector-core/src/http-api-definition/remotes.ts` (List / Get /
//! Create / Update / Delete, the `RemoteNotFound` 404 shape) and consumed by
//! `collector-react`'s remotes screens. A migration seeds the demo FHIR
//! remote, so a fresh install has a working remote out of the box.
//!
//! The per-collector config union is **TS-owned** (`collector-core`'s
//! registry): each remote's tagged `CollectorConfig` JSON is stored and served
//! verbatim, so adding a TS collector never requires a Rust change. The only
//! field Rust reads is `config._tag`, denormalized into the `tag` column at
//! write time (see [`domain::config_tag`]).
//!
//! SECURITY (decided for v1, see the Rexall collector epic): a remote's config
//! may carry pharmacy credentials, stored plaintext inside the config JSON
//! column. Moving secrets to OS keychain / encrypted storage via a Tauri
//! secret-storage mechanism is a tracked follow-up.
//!
//! Layered like `tunnel-rust` and `apps-rust`:
//!
//!  - [`domain`] — core types: [`domain::Remote`] (the diesel-mapped row
//!    **and** wire shape) and the [`domain::config_tag`] discriminant reader.
//!  - [`db`] — the SQLite store ([`db::SqliteRemotesStore`]) built on Diesel over
//!    the app-wide r2d2 connection pool (`persistence_rust::DieselPool`) onto the
//!    shared database file, migrated with embedded diesel migrations.
//!  - [`http`] — the slice's router; the wire contract is pinned from both
//!    sides by the committed OpenAPI snapshot (see [`http`]).

pub mod db;
pub mod domain;
pub mod http;

use std::sync::Arc;

use anyhow::Context;
use axum::Router;
// Re-exported so the host can name the pool type at the `setup_collector` call
// site without a direct diesel dependency; the canonical home is
// persistence-rust.
pub use persistence_rust::DieselPool;

pub use db::SqliteRemotesStore;
pub use http::{openapi_spec, CollectorState};

/// Build the collector router over the host-owned connection `pool`, mirroring
/// `tunnel-rust`'s `setup_tunnel` and `apps-rust`'s `setup_apps`. The host opens
/// the shared database with its rusqlite `persistence-rust::Connection` for the
/// other slices and builds the app-wide diesel pool (via
/// `persistence_rust::open_pool`) as an additional opener onto the same file
/// (SQLite permits multiple connections per file); constructing the store
/// applies the embedded collector migrations (including the demo-remote seed)
/// once. Because WAL is deliberately OFF repo-wide, SQLite allows a single
/// writer at a time across ALL connections; the pool's `busy_timeout` covers
/// both cross-connection contention (with the host's rusqlite connection) and
/// intra-pool write contention.
///
/// The returned router carries no middleware — every endpoint exposes
/// owner-only data, so the consumer MUST wrap it with its auth gate (the Tauri
/// host applies `layer_router_with_gatekeeper_auth_gating`).
///
/// # Errors
///
/// Returns an error if the store can't run its migrations on a pooled
/// connection.
pub fn setup_collector(pool: DieselPool) -> anyhow::Result<Router> {
    let store = SqliteRemotesStore::new(pool).context("failed to open remotes store")?;
    Ok(http::router(Arc::new(CollectorState::new(store))))
}
