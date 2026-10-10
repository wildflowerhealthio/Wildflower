//! The embedded rathole client that dials the relay.
//!
//! [`RelayClient`] is a one-attempt seam: `run_once` brings up a single rathole
//! client and returns when it exits. The [`TunnelDaemon`](crate::domain::TunnelDaemon)
//! supervisor owns the retry/backoff loop and cancellation, so this layer holds
//! no run lifecycle of its own. The trait exists so the supervisor can be tested
//! against a fake instead of a live relay.
//!
//! The client connects to no local port: it hands each visitor's connection,
//! in process, to the sender it is given, as a [`TunnelStream`].

use rathole_settings_rust::PublicRatholeSettings;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// One visitor's connection through the relay, as the rathole client hands it
/// over: the bytes of exactly that visitor, from the relay.
pub type TunnelStream = Box<dyn rathole::AsyncStream>;

/// A fully-specified relay connection: every field the rathole client needs,
/// built from the server's record.
///
/// `Debug` writes `<redacted>` in place of the `token`, as the record's own
/// `TunnelToken` does, so logging a config that holds these can't leak it.
#[derive(Clone, PartialEq, Eq)]
pub struct RelaySettings {
    pub remote_addr: String,
    pub token: String,
    pub public_key: String,
    pub service_name: String,
}

impl RelaySettings {
    /// The connection to the relay that served `relay` at `GET /rathole`, for
    /// this device's tunnel `service_name` and its `token`.
    #[must_use]
    pub fn from_public_rathole_settings(
        relay: PublicRatholeSettings,
        service_name: String,
        token: String,
    ) -> Self {
        Self {
            remote_addr: relay.remote_addr,
            token,
            public_key: relay.public_key,
            service_name,
        }
    }
}

impl std::fmt::Debug for RelaySettings {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RelaySettings")
            .field("remote_addr", &self.remote_addr)
            .field("token", &"<redacted>")
            .field("public_key", &self.public_key)
            .field("service_name", &self.service_name)
            .finish()
    }
}

/// Runs a single rathole client attempt. The supervisor calls this in a loop.
#[async_trait::async_trait]
pub trait RelayClient: Send + Sync {
    /// Bring up the tunnel per `relay`, sending each visitor's stream to
    /// `tunnel_stream_tx`, and run until the client exits. Resolves `Ok` on
    /// a clean stop — `cancel` fired, or the relay closed the session without
    /// error — and `Err` on a failure the supervisor should back off and retry
    /// (relay unreachable, handshake rejected).
    async fn run_once(
        &self,
        relay: &RelaySettings,
        tunnel_stream_tx: mpsc::Sender<TunnelStream>,
        cancel: CancellationToken,
    ) -> anyhow::Result<()>;
}

#[cfg(test)]
mod tests {
    use super::RelaySettings;

    #[test]
    fn debug_redacts_the_token() {
        let rendered = format!(
            "{:?}",
            RelaySettings {
                remote_addr: "relay.example.com:2333".into(),
                token: "s3cret-relay-token".into(),
                public_key: "key".into(),
                service_name: "dev1".into(),
            }
        );
        assert!(
            !rendered.contains("s3cret-relay-token"),
            "token leaked: {rendered}"
        );
        assert!(rendered.contains("<redacted>"), "{rendered}");
        assert!(rendered.contains("relay.example.com:2333"), "{rendered}");
    }
}
