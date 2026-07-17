//! The gatekeeper persistence **port**, split into two pure traits the domain
//! depends on:
//!
//! - [`GatekeeperTx`] is the primitive contract — every single-statement CRUD
//!   operation the domain needs, over the gatekeeper's domain types, taking
//!   `&mut self` so a batch of them can run against one connection. It signals
//!   absence/conflict through return types (`Option` / `bool`) rather than
//!   semantic errors, raising only the opaque
//!   [`Infrastructure`](GatekeeperError::Infrastructure) failure. The semantic
//!   outcomes (the various `*NotFound`) are decided one layer up, in
//!   `domain::capabilities`.
//! - [`GatekeeperStore`] is the **transaction seam**: it hands the domain a
//!   [`GatekeeperTx`] scoped to one connection, either in autocommit
//!   ([`with_connection`](GatekeeperStore::with_connection)) or wrapped in a
//!   [`transaction`](GatekeeperStore::transaction) /
//!   [`immediate_transaction`](GatekeeperStore::immediate_transaction). A
//!   multi-statement operation that must be atomic (a grant upsert's
//!   read-merge-write, a token rotation's consume-then-decide, a revoke's
//!   delete-both-then-expire) is composed in `domain::capabilities` from
//!   `GatekeeperTx` primitives inside one of these transactions — so the logic
//!   lives in the pure domain, unit-tested against the in-memory
//!   `FakeGatekeeperStore`, and the `SQLite` adapter carries only the primitives
//!   plus the three transaction runners.
//!
//! Every read/simple-write the routes call standalone is still available
//! directly on [`GatekeeperStore`] as a **default** method that runs the
//! primitive through [`with_connection`](GatekeeperStore::with_connection), so
//! callers that don't compose keep calling `store.client_by_id(..)` unchanged.
//!
//! The `SQLite` adapter lives in [`crate::db`] as `SqliteGatekeeperStore` (its
//! `SqliteGatekeeperTx` implements [`GatekeeperTx`]); the in-memory
//! `FakeGatekeeperStore` in `domain::capabilities` substitutes for it in the
//! semantic-mapping unit tests. Mirrors `collector-rust`'s `RemotesStore` and
//! `tunnel-rust`'s `TunnelStore`, scaled up to the gatekeeper's six persistence
//! concerns — plus the transaction seam neither of those simpler CRUD stores
//! needed.

mod store;
mod tx;

pub use store::GatekeeperStore;
pub use tx::GatekeeperTx;
