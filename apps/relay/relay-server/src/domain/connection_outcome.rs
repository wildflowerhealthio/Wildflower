//! What became of a connection to the front's `:443`: [`TunnelOutcome`] for
//! one routed to a tunnel, and [`Outcome`], which adds the refusals that
//! come before any tunnel is known. Neither carries an identifier: the
//! tunnel an outcome was for is kept beside it only in memory (see
//! [`crate::outcomes`]), and the hourly totals are keyed by the outcome
//! alone.

use serde::{Serialize, Serializer};

/// What became of a connection routed to a known tunnel. Its wire name (see
/// [`Outcome::as_str`]) is what `GET /api/tunnels` reports as a tunnel's
/// `last_outcome`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TunnelOutcome {
    /// The PROXY header and the hello reached the tunnel's visitor pipe.
    /// Whatever the pipe does after that, the outcome stays this.
    Ok,
    /// The tunnel's device is not connected.
    TunnelDown,
    /// The device is connected, but its visitor queue stayed full past the
    /// hello deadline.
    TunnelBusy,
    /// rathole dropped the visitor before the PROXY header and hello were
    /// written.
    TunnelClosed,
    /// The PROXY header could not be built.
    ProxyHeaderFailed,
}

impl Serialize for TunnelOutcome {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(Outcome::from(*self).as_str())
    }
}

/// What became of a connection to `:443`, as the hourly totals count it:
/// every [`TunnelOutcome`], plus the refusals before a tunnel is known.
/// Connections to the relay's own hostnames are not counted at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Outcome {
    /// See [`TunnelOutcome::Ok`].
    Ok,
    /// The front was at its connection limit, and dropped the connection
    /// before reading from it.
    OverConnectionLimit,
    /// No complete ClientHello arrived within the deadline.
    HelloTimeout,
    /// The first bytes were not a ClientHello, or the client closed or the
    /// read failed first.
    NotAHello,
    /// A ClientHello with no DNS server name (none, or an IP literal).
    NoServerName,
    /// A server name that names no served tunnel and none of the relay's own
    /// hostnames.
    UnknownTunnel,
    /// See [`TunnelOutcome::TunnelDown`].
    TunnelDown,
    /// See [`TunnelOutcome::TunnelBusy`].
    TunnelBusy,
    /// See [`TunnelOutcome::TunnelClosed`].
    TunnelClosed,
    /// See [`TunnelOutcome::ProxyHeaderFailed`].
    ProxyHeaderFailed,
}

impl Outcome {
    /// Every outcome, in the order the admin API's totals list them.
    pub const ALL: [Self; 10] = [
        Self::Ok,
        Self::OverConnectionLimit,
        Self::HelloTimeout,
        Self::NotAHello,
        Self::NoServerName,
        Self::UnknownTunnel,
        Self::TunnelDown,
        Self::TunnelBusy,
        Self::TunnelClosed,
        Self::ProxyHeaderFailed,
    ];

    /// The outcome's name on the wire and in the database: `snake_case`.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::OverConnectionLimit => "over_connection_limit",
            Self::HelloTimeout => "hello_timeout",
            Self::NotAHello => "not_a_hello",
            Self::NoServerName => "no_server_name",
            Self::UnknownTunnel => "unknown_tunnel",
            Self::TunnelDown => "tunnel_down",
            Self::TunnelBusy => "tunnel_busy",
            Self::TunnelClosed => "tunnel_closed",
            Self::ProxyHeaderFailed => "proxy_header_failed",
        }
    }

    /// The outcome named `name` (see [`Outcome::as_str`]), if any is.
    #[must_use]
    pub fn parse(name: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|outcome| outcome.as_str() == name)
    }
}

impl From<TunnelOutcome> for Outcome {
    fn from(outcome: TunnelOutcome) -> Self {
        match outcome {
            TunnelOutcome::Ok => Self::Ok,
            TunnelOutcome::TunnelDown => Self::TunnelDown,
            TunnelOutcome::TunnelBusy => Self::TunnelBusy,
            TunnelOutcome::TunnelClosed => Self::TunnelClosed,
            TunnelOutcome::ProxyHeaderFailed => Self::ProxyHeaderFailed,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_outcome_parses_back_from_its_name() {
        for outcome in Outcome::ALL {
            assert_eq!(Outcome::parse(outcome.as_str()), Some(outcome));
        }
        assert_eq!(Outcome::parse("unknown"), None);
    }

    #[test]
    fn a_tunnel_outcome_serializes_as_its_outcome_name() {
        assert_eq!(
            serde_json::to_value(TunnelOutcome::TunnelBusy).unwrap(),
            "tunnel_busy"
        );
    }
}
