//! [`TunnelState`]: where the tunnel's connection to the relay stands, as the
//! [`TunnelDaemon`](crate::domain::TunnelDaemon) publishes it.
//!
//! ```text
//!   spawn                                 ──► Connecting
//!   the relay accepts the control channel ──► Connected
//!   a dial fails, or the connection drops ──► Reconnecting { error }   dial again after a backoff
//!   the relay refuses the token           ──► TokenRejected            stop dialing
//!   the relay has no tunnel of this name  ──► TunnelUnknown            stop dialing
//! ```

use wildflowerhealthio_shared_structures::health_check::HealthStatus;

/// Where the tunnel's connection to the relay stands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TunnelState {
    /// The first dial is under way: the relay hasn't accepted the control
    /// channel yet.
    Connecting,
    /// The relay accepted the control channel, which is up.
    Connected,
    /// The last dial failed, or the connection was lost, with `error`; the
    /// daemon is backing off before it dials again.
    Reconnecting { error: String },
    /// The relay refused the tunnel's token. The daemon has stopped dialing.
    TokenRejected,
    /// The relay has no tunnel of this name. The daemon has stopped dialing.
    TunnelUnknown,
}

impl TunnelState {
    /// The tunnel's health, as the server's `/health` reports it as its
    /// `connectivity` check: `Pass` while connected, `Warn` while dialing
    /// again, and `Fail` once the daemon has stopped dialing.
    #[must_use]
    pub fn connectivity(&self) -> HealthStatus {
        match self {
            TunnelState::Connected => HealthStatus::Pass,
            TunnelState::Connecting | TunnelState::Reconnecting { .. } => HealthStatus::Warn,
            TunnelState::TokenRejected | TunnelState::TunnelUnknown => HealthStatus::Fail,
        }
    }
}
