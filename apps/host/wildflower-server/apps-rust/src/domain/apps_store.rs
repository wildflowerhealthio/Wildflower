//! The [`AppsStore`] **port** — the pure trait the domain depends on for
//! persistence. No diesel or axum here: the port speaks only
//! [`AppRegistration`]s. It signals absence / non-permutation through `Option` and
//! a delete miss through `bool`, raising only the opaque
//! [`Infrastructure`](AppsError::Infrastructure) failure. The semantic outcomes
//! (`NotFound`, `InvalidHomeScreen`) — and the synthesis
//! of the registration a create/replace persists — are decided one layer up, in
//! the [`capabilities`](crate::domain::capabilities), so both the `SQLite` adapter
//! and an in-memory test fake implement the same contract.
//!
//! The `SQLite` adapter lives in [`crate::db`] as `SqliteAppsStore`; tests
//! substitute the in-memory `FakeAppsStore` in `crate::domain::test_fake`.
//! Mirrors collector's `RemotesStore` port.

use crate::domain::{AppRegistration, AppsError};

/// The persistence port for the apps registry: the primitive CRUD the domain
/// needs over [`AppRegistration`]s, raising the opaque
/// [`AppsError::Infrastructure`]. Absence is a return-type signal (`find_app`
/// returns `None`; `replace_app` returns `None` when it affects no row;
/// `delete_app` returns `false` on a miss); a non-permutation placement body is
/// `None` — NOT semantic errors. The capabilities map those signals onto
/// `NotFound` / `InvalidHomeScreen`, and synthesize the
/// registration each write persists. The `SQLite` adapter
/// (`crate::db::SqliteAppsStore`) implements it; unit tests swap in the in-memory
/// `FakeAppsStore`.
///
/// Every create / replace returns the stored registration via `RETURNING`, *from
/// the same statement that wrote it*, so a caller's response can't drift from
/// stored state (see `docs/Apps/Store Explanation.md`).
pub trait AppsStore {
    /// The `GET /apps` catalogue: every app's registration, ordered by `position`.
    ///
    /// # Errors
    ///
    /// [`AppsError::Infrastructure`] on a checkout / read failure or a corrupt row.
    fn list_registrations(&self) -> Result<Vec<AppRegistration>, AppsError>;

    /// A single app by id, or `None` when no app has this id. Backs the detail
    /// read, the edit, and the launch.
    ///
    /// # Errors
    ///
    /// [`AppsError::Infrastructure`] on a checkout / read failure or a corrupt row.
    fn find_app(&self, id: &str) -> Result<Option<AppRegistration>, AppsError>;

    /// Insert a fresh app from a caller-built `registration`. The store owns the
    /// display `position` (assigned at the tail, overriding whatever the caller
    /// passed); everything else on the registration is used as given. Returns the
    /// inserted registration via `RETURNING`.
    ///
    /// # Errors
    ///
    /// [`AppsError::Infrastructure`] on a checkout / transaction failure, or when
    /// the id is already taken (the primary key rejects it rather than silently
    /// overwriting; ids are server-minted, so a collision is a fault).
    fn insert_app(&self, registration: &AppRegistration) -> Result<AppRegistration, AppsError>;

    /// Replace an app's editable fields from a caller-built `registration`,
    /// located by `registration.id`: `name` / `subtitle` / `url` /
    /// `requires_tunnel`. Never touches `position` / `on_homescreen` (the
    /// placement single-writer) or the other columns. Returns `None` when no app
    /// has this id, else the updated registration returned via `RETURNING`.
    ///
    /// # Errors
    ///
    /// [`AppsError::Infrastructure`] on a checkout / transaction failure.
    fn replace_app(
        &self,
        registration: &AppRegistration,
    ) -> Result<Option<AppRegistration>, AppsError>;

    /// Delete an app by id. Returns `true` when a row was removed, `false` on a
    /// miss.
    ///
    /// # Errors
    ///
    /// [`AppsError::Infrastructure`] on a checkout / transaction failure.
    fn delete_app(&self, id: &str) -> Result<bool, AppsError>;

    /// Atomically validate **and** rewrite the whole homescreen placement (ordering
    /// **and** `on_homescreen` flags) in one transaction. Returns the resulting
    /// registry in its new order (read inside the same transaction), or `None` —
    /// the sole non-infrastructure failure — when `entries` isn't an exact
    /// permutation of the live registry.
    ///
    /// The sole writer of `position` / `on_homescreen`. See
    /// `docs/Apps/Store Explanation.md`.
    ///
    /// # Errors
    ///
    /// [`AppsError::Infrastructure`] on a checkout / transaction failure.
    fn replace_placements(
        &self,
        entries: &[(String, bool)],
    ) -> Result<Option<Vec<AppRegistration>>, AppsError>;
}
