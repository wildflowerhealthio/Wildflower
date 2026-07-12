//! The [`TunnelStore`] **port** — the pure trait the domain depends on for
//! persistence, plus the small param/outcome types its methods speak
//! ([`SettingsUpdate`], [`SettingsUpdateOutcome`], [`SettingsSeed`]). No diesel,
//! axum, or rathole here: the port is defined entirely in domain types so
//! [`crate::domain::actions`] (and its tests) can drive it without a database or
//! HTTP layer.
//!
//! The `SQLite` adapter lives in [`crate::db`] as `SqliteTunnelStore`; tests
//! substitute an in-memory fake. Every operation returns the domain
//! [`TunnelError`] — its only variant is the opaque
//! [`Infrastructure`](TunnelError::Infrastructure) failure, because the settings
//! surface has no semantic error (a stale-revision write is the normal
//! [`SettingsUpdateOutcome::Conflict`] success outcome, not an error).

use crate::domain::{RelaySettings, TunnelError, TunnelSettings};

/// A full replacement of the settings' visible fields, plus an optional
/// write-only relay block: `relay_settings: None` keeps the stored relay
/// connection, `relay_settings: Some(_)` replaces all four relay fields
/// together.
#[derive(Debug, Clone)]
pub struct SettingsUpdate {
    pub public_host: Option<String>,
    pub requested_running: bool,
    pub relay_settings: Option<RelaySettings>,
}

/// The result of a compare-and-swap write: `Applied` when the expected revision
/// matched (carrying the new row), `Conflict` when it didn't (carrying the
/// current row so the caller can re-read and retry).
#[derive(Debug)]
pub enum SettingsUpdateOutcome {
    Applied(TunnelSettings),
    Conflict(TunnelSettings),
}

/// Build-time defaults seeded into the row at startup. Each field fills the
/// stored value only when it's currently unconfigured (see
/// [`TunnelStore::seed_if_absent`]), so a fresh install picks up the baked-in
/// connection while an in-app edit is never overwritten.
#[derive(Debug, Clone, Default)]
pub struct SettingsSeed {
    pub public_host: Option<String>,
    pub relay: Option<RelaySettings>,
}

/// The persistence port for tunnel settings: the primitive CRUD the domain
/// needs, over domain types, raising only the opaque [`TunnelError`]. The
/// `SQLite` adapter (`crate::db::SqliteTunnelStore`) implements it; unit tests
/// swap in an in-memory fake. Domain logic reaches the store through
/// [`crate::domain::actions`], never a concrete store type.
pub trait TunnelStore {
    /// Read the singleton settings row.
    ///
    /// # Errors
    ///
    /// [`TunnelError::Infrastructure`] on a checkout / read failure.
    fn get_settings(&self) -> Result<TunnelSettings, TunnelError>;

    /// Replace the settings iff `expected_revision` still matches the stored
    /// revision, bumping the revision on success. The visible fields are fully
    /// replaced; the relay block is replaced only when `update.relay_settings`
    /// is set (otherwise the stored relay connection is kept). Returns
    /// [`SettingsUpdateOutcome::Conflict`] (with the current row) when the
    /// revision has moved on.
    ///
    /// # Errors
    ///
    /// [`TunnelError::Infrastructure`] on a checkout / update / read-back
    /// failure.
    fn replace_settings(
        &self,
        expected_revision: i64,
        update: SettingsUpdate,
    ) -> Result<SettingsUpdateOutcome, TunnelError>;

    /// Fill `public_host` and/or the relay block from build-time defaults, but
    /// only where the stored value is currently unconfigured — an in-app edit is
    /// never clobbered. Does **not** bump `revision` (this is initialization,
    /// not a user write). A no-op once configured, or when the seed is empty.
    ///
    /// # Errors
    ///
    /// [`TunnelError::Infrastructure`] on a checkout / read-back / update
    /// failure.
    fn seed_if_absent(&self, seed: &SettingsSeed) -> Result<(), TunnelError>;
}
