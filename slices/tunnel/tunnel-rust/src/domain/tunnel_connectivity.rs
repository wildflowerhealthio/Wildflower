//! [`TunnelConnectivity`]: how well the tunnel says it is carrying the
//! server's traffic.

/// How well the tunnel is carrying the server's traffic, as the tunnel itself
/// judges it. The server's `/health` reports it as its `connectivity` check.
///
/// The [`TunnelDaemon`](crate::TunnelDaemon) publishes it for as long as it
/// runs. It starts [`Normal`](Self::Normal) and nothing marks it
/// [`Degraded`](Self::Degraded) yet: the daemon only dials and re-dials, and
/// logs each outcome.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TunnelConnectivity {
    /// Nothing is known to be wrong with the tunnel.
    Normal,
    /// The tunnel is up but misbehaving, so remote apps may see slow or failed
    /// requests.
    Degraded,
}
