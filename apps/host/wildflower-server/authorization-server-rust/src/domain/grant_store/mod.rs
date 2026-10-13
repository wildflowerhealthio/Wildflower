//! The authorization server persistence **port**, split into two pure traits the domain
//! depends on:
//!
//! - [`GrantTx`] is the primitive contract — every single-statement CRUD
//!   operation the domain needs, over the authorization server's domain types, taking
//!   `&mut self` so a batch of them can run against one connection. It signals
//!   absence/conflict through return types (`Option` / `bool`) rather than
//!   semantic errors, raising only the opaque
//!   [`Infrastructure`](AuthorizationServerError::Infrastructure) failure. The semantic
//!   outcomes (the various `*NotFound`) are decided one layer up, in
//!   `domain::capabilities`.
//! - [`GrantStore`] is the **transaction seam**: it hands the domain a
//!   [`GrantTx`] scoped to one connection, either in autocommit
//!   ([`with_connection`](GrantStore::with_connection)) or wrapped in a
//!   [`transaction`](GrantStore::transaction) /
//!   [`immediate_transaction`](GrantStore::immediate_transaction). A
//!   multi-statement operation that must be atomic (a grant upsert's
//!   read-merge-write, a token rotation's consume-then-decide, a revoke's
//!   delete-both-then-expire) is composed in `domain::capabilities` from
//!   `GrantTx` primitives inside one of these transactions — so the logic
//!   lives in the pure domain, unit-tested against the in-memory
//!   `FakeGrantStore`, and the `SQLite` adapter carries only the primitives
//!   plus the three transaction runners.
//!
//! Every read/simple-write the routes call standalone is still available
//! directly on [`GrantStore`] as a **default** method that runs the
//! primitive through [`with_connection`](GrantStore::with_connection), so
//! callers that don't compose keep calling `store.client_by_id(..)` unchanged.
//!
//! The `SQLite` adapter lives in [`crate::db`] as `SqliteGrantStore` (its
//! `SqliteGrantTx` implements [`GrantTx`]); the in-memory
//! `FakeGrantStore` in `domain::capabilities` substitutes for it in the
//! semantic-mapping unit tests. Mirrors `apps-rust`'s `AppsStore`, scaled up to
//! the authorization server's six persistence concerns — plus the transaction seam that
//! simpler store doesn't need.

mod store;
mod tx;

pub use store::GrantStore;
pub use tx::GrantTx;
