//! The persisted tunnel settings: the public host the relay edge serves this
//! device at, the on/off intent, and the write-only relay connection details.
//!
//! This is the single source of truth (stored in SQLite). `public_host` is
//! shown to the user; the relay fields are set through the API but never
//! returned on the wire. Until every relay field is present the tunnel is "not
//! configured" and a start request reports that rather than connecting.
//!
//! `revision` is a monotonically increasing version bumped on every accepted
//! write; it is the optimistic-concurrency token a PUT must match (and the key
//! that decides which tunnel run is live).

use crate::domain::relay_client::RelaySettings;

/// The full settings row. Relay fields are `Option` because they are unset on a
/// fresh install.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TunnelSettings {
    /// Optimistic-concurrency version, bumped on each accepted write.
    pub revision: i64,
    /// The full public hostname the relay edge serves this device at, e.g.
    /// `dev1.example.com`. Drives `servedOrigin`; shown to the user.
    pub public_host: Option<String>,
    /// On/off intent. Persisted so the tunnel auto-resumes after a restart.
    pub requested_running: bool,
    /// The relay connection details. Configuration is all or nothing,`None` unless all fields are present.
    pub relay_settings: Option<RelaySettings>,
}
