//! The [`AppsStore`] **port** — the pure trait the domain depends on for
//! persistence. No diesel or axum here: the port speaks primitive CRUD over the
//! domain [`App`] type and the write-side input specs, signalling absence /
//! conflict / allocation-failure through return types (`Option` / `bool` /
//! [`UploadInsertError`]) rather than semantic errors, and raising only the
//! opaque [`Infrastructure`](AppError::Infrastructure) failure. The semantic
//! outcomes (`NotFound`, `NotEditable`, `InvalidHomeScreen`, the id-collision and
//! upload-failure mappings) are decided one layer up, in
//! [`crate::domain::actions`], so both the `SQLite` adapter and an in-memory test
//! fake implement the same primitive contract.
//!
//! The `SQLite` adapter lives in [`crate::db`] as `SqliteAppsStore`; tests
//! substitute the in-memory `FakeAppsStore` in [`crate::domain::actions`].
//! Mirrors collector's `RemotesStore` port.

use crate::domain::{
    App, AppError, AppRegistration, CloudContent, NewCloudApp, NewSelfHostedUpload,
    UploadInsertError,
};

/// The persistence port for the apps registry: the primitive CRUD the domain
/// needs, over the whole domain [`App`] and the caller-owned write specs, raising
/// only the opaque [`AppError::Infrastructure`]. Absence is a return-type signal
/// (`find_app` returns `None`; `insert_cloud_app` / `replace_*` return `None`
/// when they affect no row; `delete_app` returns `false` on a miss); a
/// self-hosted upload's slug / port exhaustion is an [`UploadInsertError`]; a
/// non-permutation home-screen body is `None` — NOT semantic errors.
/// [`crate::domain::actions`] maps those signals onto `NotFound` / `NotEditable`
/// / `InvalidHomeScreen` and the id-collision / upload-failure verdicts. The
/// `SQLite` adapter (`crate::db::SqliteAppsStore`) implements it; unit tests swap
/// in the in-memory `FakeAppsStore`.
///
/// Every create / replace re-reads and returns the hydrated [`App`] *inside the
/// same transaction that wrote it*, so a caller's response can't drift from
/// stored state (see `docs/Apps/Store and Install Explanation.md`).
pub trait AppsStore {
    /// The `GET /apps` catalogue: every app's registration, ordered by `position`.
    /// Join-free (the registration carries everything the tile renders); the
    /// per-kind payload is read only on a detail lookup.
    ///
    /// # Errors
    ///
    /// [`AppError::Infrastructure`] on a checkout / read failure or a corrupt row.
    fn list_registrations(&self) -> Result<Vec<AppRegistration>, AppError>;

    /// A single whole app by id, or `None` when no app has this id. Reads the
    /// registration then the one child payload its `kind` names. Backs the launch
    /// dispatch, the per-kind detail reads, and the admin existence checks.
    ///
    /// # Errors
    ///
    /// [`AppError::Infrastructure`] on a checkout / read failure or a corrupt row.
    fn find_app(&self, id: &str) -> Result<Option<App>, AppError>;

    /// Every self-hosted app, whole, in display order. The host materializes this
    /// once at setup to bind a loopback listener per app.
    ///
    /// # Errors
    ///
    /// [`AppError::Infrastructure`] on a checkout / read failure or a corrupt row.
    fn list_self_hosted_apps(&self) -> Result<Vec<App>, AppError>;

    /// Insert a fresh cloud app (its `app_registry` registration at the tail
    /// position plus its `cloud_apps` payload) in one transaction. Returns `None`
    /// when the id was already taken (no row written) — a conflict rather than a
    /// silent overwrite — else the inserted whole [`App`] read back in-txn.
    ///
    /// # Errors
    ///
    /// [`AppError::Infrastructure`] on a checkout / transaction failure.
    fn insert_cloud_app(&self, new: &NewCloudApp) -> Result<Option<App>, AppError>;

    /// Insert a fresh uploaded self-hosted app — its `app_registry` registration
    /// (allocating slug, port, and position in-transaction) plus its
    /// `self_hosted_apps` payload. Returns `Ok(Err(_))` — nothing written — when
    /// the slug attempts or the port space are exhausted; otherwise the inserted
    /// whole [`App`] read back in-txn.
    ///
    /// # Errors
    ///
    /// [`AppError::Infrastructure`] on a checkout / transaction failure.
    fn insert_self_hosted_app(
        &self,
        new: &NewSelfHostedUpload,
    ) -> Result<Result<App, UploadInsertError>, AppError>;

    /// Replace a cloud app's *content* (`name` / `subtitle` / `url` /
    /// `requires_tunnel`); never touches `enabled` / position. Returns `None` when
    /// no cloud app has this id, else the updated whole [`App`] read back in-txn.
    ///
    /// # Errors
    ///
    /// [`AppError::Infrastructure`] on a checkout / transaction failure.
    fn replace_cloud_content(
        &self,
        id: &str,
        content: &CloudContent,
    ) -> Result<Option<App>, AppError>;

    /// Replace a self-hosted app's `launch_path` (`None` clears it back to
    /// root-serving). Returns `None` when no self-hosted app has this id, else the
    /// updated whole [`App`] read back in-txn.
    ///
    /// # Errors
    ///
    /// [`AppError::Infrastructure`] on a checkout / transaction failure.
    fn replace_self_hosted_launch_path(
        &self,
        id: &str,
        launch_path: Option<&str>,
    ) -> Result<Option<App>, AppError>;

    /// Delete an app by id, any kind — one `app_registry` delete; its child
    /// payload cascades. Returns `true` when a row was removed, `false` on a miss.
    /// The removability policy (kind + seeded) is enforced above this.
    ///
    /// # Errors
    ///
    /// [`AppError::Infrastructure`] on a checkout / transaction failure.
    fn delete_app(&self, id: &str) -> Result<bool, AppError>;

    /// Atomically validate **and** rewrite the whole homescreen (ordering **and**
    /// `enabled` flags) in one transaction. Returns the resulting registry in its
    /// new order (read inside the same transaction), or `None` when `entries`
    /// isn't an exact permutation of the live registry.
    ///
    /// The sole writer of `position` / `enabled` across every kind. See
    /// `docs/Apps/Store and Install Explanation.md`.
    ///
    /// # Errors
    ///
    /// [`AppError::Infrastructure`] on a checkout / transaction failure.
    fn replace_home_screen(
        &self,
        entries: &[(String, bool)],
    ) -> Result<Option<Vec<AppRegistration>>, AppError>;
}
