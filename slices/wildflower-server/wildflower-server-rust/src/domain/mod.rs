//! The server's own rules about itself, free of HTTP clients and stores:
//!
//! - [`server_health`] — [`ServerHealth`](server_health::ServerHealth), whether
//!   the server's `/health` answers through its public origin, and with what.
//! - [`certificate_authority`] — [`CertificateAuthority`](certificate_authority::CertificateAuthority),
//!   the ACME CA a server's certificates are ordered from.
//! - [`certificate_state`] — [`CertificateState`](certificate_state::CertificateState),
//!   where the server's certificate stands, and the
//!   [`ObservedCertificate`](certificate_state::ObservedCertificate) a run
//!   derives it from: what it has observed of its certificate's events.
//! - [`certificate_history`] — [`CertificateHistoryEntry`](certificate_history::CertificateHistoryEntry),
//!   one certificate a server deployed, as its history records it.
//! - [`reachability_monitor`] — the task that asks, on a cadence, through the
//!   [`HealthProbe`](reachability_monitor::HealthProbe) port.

pub(crate) mod certificate_authority;
pub(crate) mod certificate_history;
pub(crate) mod certificate_state;
pub(crate) mod reachability_monitor;
pub(crate) mod server_health;
