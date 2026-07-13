//! The [`AppsStore`] **port** — the pure trait the domain depends on for
//! persistence. No diesel or axum here: the port speaks only concrete
//! registrations, configurations, and `(AppRegistration, …Configuration)` pairs —
//! there is no "combined app" input, and the only union it returns is
//! [`AppConfiguration`] on [`find_app`](AppsStore::find_app), where the kind isn't
//! known at the call site. It signals absence / non-permutation through `Option`, a
//! delete miss through `bool`, and an insert that wrote nothing through a granular
//! typed error ([`CloudInsertError`] / [`UploadInsertError`]) rather than a bare
//! `None`, raising only the opaque [`Infrastructure`](AppsError::Infrastructure)
//! failure. The semantic outcomes (`NotFound`, `NotEditable`, `InvalidHomeScreen`,
//! the id-collision and upload-failure mappings) — and the synthesis of the
//! registration + configuration a create/replace persists — are decided one layer
//! up, in [`crate::domain::actions`], so both the `SQLite` adapter and an in-memory
//! test fake implement the same primitive contract.
//!
//! The `SQLite` adapter lives in [`crate::db`] as `SqliteAppsStore`; tests
//! substitute the in-memory `FakeAppsStore` in [`crate::domain::actions`].
//! Mirrors collector's `RemotesStore` port.

use crate::domain::{
    AppConfiguration, AppRegistration, AppsError, CloudAppConfiguration, CloudInsertError,
    NewSelfHostedUpload, SelfHostedAppConfiguration, UploadInsertError,
};

/// The persistence port for the apps registry: the primitive CRUD the domain
/// needs, over concrete registrations / configurations / pairs (and the
/// [`AppConfiguration`] union only where the kind is runtime-resolved), raising only
/// the opaque [`AppsError::Infrastructure`]. Absence is a return-type signal
/// (`find_app` returns `None`; `replace_*` return `None` when they affect no row;
/// `delete_app` returns `false` on a miss); an insert that wrote nothing is a
/// granular typed error (a cloud id-collision [`CloudInsertError`]; a self-hosted
/// upload's slug / port exhaustion [`UploadInsertError`]); a non-permutation
/// placement body is `None` — NOT semantic errors. [`crate::domain::actions`] maps
/// those signals onto `NotFound` / `NotEditable` / `InvalidHomeScreen` and the
/// id-collision / upload-failure verdicts, and synthesizes the registration +
/// configuration each write persists. The `SQLite` adapter
/// (`crate::db::SqliteAppsStore`) implements it; unit tests swap in the in-memory
/// `FakeAppsStore`.
///
/// Every create / replace re-reads and returns the hydrated pair *inside the same
/// transaction that wrote it*, so a caller's response can't drift from stored
/// state (see `docs/Apps/Store and Install Explanation.md`).
pub trait AppsStore {
    /// The `GET /apps` catalogue: every app's registration, ordered by `position`.
    /// Join-free (the registration carries everything the tile renders); the
    /// per-kind configuration is read only on a detail lookup.
    ///
    /// # Errors
    ///
    /// [`AppsError::Infrastructure`] on a checkout / read failure or a corrupt row.
    fn list_registrations(&self) -> Result<Vec<AppRegistration>, AppsError>;

    /// A single whole app by id, or `None` when no app has this id. Reads the
    /// registration then the one configuration its `kind` names, returning the
    /// `(registration, configuration)` pair (the configuration as the
    /// [`AppConfiguration`] union, since the kind isn't known at the call site) —
    /// it backs the launch dispatch and the delete removability check.
    ///
    /// # Errors
    ///
    /// [`AppsError::Infrastructure`] on a checkout / read failure or a corrupt row.
    fn find_app(&self, id: &str) -> Result<Option<(AppRegistration, AppConfiguration)>, AppsError>;

    /// Every self-hosted app, as `(registration, configuration)` pairs, in display
    /// order. The host materializes this once at setup to bind a loopback listener
    /// per app.
    ///
    /// # Errors
    ///
    /// [`AppsError::Infrastructure`] on a checkout / read failure or a corrupt row.
    fn list_self_hosted_apps(
        &self,
    ) -> Result<Vec<(AppRegistration, SelfHostedAppConfiguration)>, AppsError>;

    /// Insert a fresh cloud app from a caller-built `registration` + `config`. The
    /// store owns the display `position` (assigned at the tail, overriding whatever
    /// the caller passed); everything else on the registration is used as given.
    /// Returns [`CloudInsertError::IdTaken`] — nothing written — when the id was
    /// already taken (a conflict rather than a silent overwrite), else the inserted
    /// `(registration, configuration)` pair read back in-txn.
    ///
    /// # Errors
    ///
    /// [`AppsError::Infrastructure`] on a checkout / transaction failure.
    fn insert_cloud_app(
        &self,
        registration: &AppRegistration,
        config: &CloudAppConfiguration,
    ) -> Result<Result<(AppRegistration, CloudAppConfiguration), CloudInsertError>, AppsError>;

    /// Insert a fresh uploaded self-hosted app — its `app_registrations`
    /// registration (allocating slug, port, and position in-transaction) plus its
    /// `self_hosted_app_configurations` payload. The slug/port genuinely can't be
    /// caller-supplied, so this keeps its allocation spec. Returns `Ok(Err(_))` —
    /// nothing written — when the slug attempts or the port space are exhausted;
    /// otherwise the inserted pair read back in-txn.
    ///
    /// # Errors
    ///
    /// [`AppsError::Infrastructure`] on a checkout / transaction failure.
    fn insert_self_hosted_app(
        &self,
        new: &NewSelfHostedUpload,
    ) -> Result<Result<(AppRegistration, SelfHostedAppConfiguration), UploadInsertError>, AppsError>;

    /// Replace a cloud app's editable fields from a caller-built `registration` +
    /// `config`, located by `registration.id`: the registration's `name` /
    /// `subtitle` / `requires_tunnel` and the `cloud_app_configurations` `url`.
    /// Never touches `position` / `on_homescreen` (the placement single-writer) or
    /// the other registration columns. Returns `None` when no cloud app has this id,
    /// else the updated pair read back in-txn.
    ///
    /// # Errors
    ///
    /// [`AppsError::Infrastructure`] on a checkout / transaction failure.
    fn replace_cloud_app(
        &self,
        registration: &AppRegistration,
        config: &CloudAppConfiguration,
    ) -> Result<Option<(AppRegistration, CloudAppConfiguration)>, AppsError>;

    /// Replace a self-hosted app's editable fields from a caller-built
    /// `registration` + `config`, located by `registration.id`: the registration's
    /// `name` / `subtitle` and the configuration's `launch_path`. Never touches
    /// placement or the immutable `port` / `subdomain` / `seeded` / `content_folder`.
    /// Returns `None` when no self-hosted app has this id, else the updated pair read
    /// back in-txn.
    ///
    /// # Errors
    ///
    /// [`AppsError::Infrastructure`] on a checkout / transaction failure.
    fn replace_self_hosted_app(
        &self,
        registration: &AppRegistration,
        config: &SelfHostedAppConfiguration,
    ) -> Result<Option<(AppRegistration, SelfHostedAppConfiguration)>, AppsError>;

    /// Delete an app by id, any kind — one `app_registrations` delete; its
    /// configuration cascades. Returns `true` when a row was removed, `false` on a
    /// miss. The removability policy (kind + seeded) is enforced above this.
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
    /// The sole writer of `position` / `on_homescreen` across every kind. See
    /// `docs/Apps/Store and Install Explanation.md`.
    ///
    /// # Errors
    ///
    /// [`AppsError::Infrastructure`] on a checkout / transaction failure.
    fn replace_placements(
        &self,
        entries: &[(String, bool)],
    ) -> Result<Option<Vec<AppRegistration>>, AppsError>;
}
