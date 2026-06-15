//! The embedded rathole client that dials the relay.
//!
//! A single [`RelayClient`] trait with one real implementation
//! ([`RatholeRelayClient`]); the "relay not configured" case is handled inside
//! `start` (empty settings -> error) rather than as a separate controller, and
//! the trait exists only as a seam so the HTTP state machine can be tested with
//! a fake instead of a live relay.
//!
//! rathole's public API only accepts a config *file* path (its `Config`-taking
//! runner is private and its `Config` doesn't cleanly re-serialize), so we
//! render the client config to a temp file whose handle lives as long as the
//! tunnel.
//!
//! [`RelayClient::start`] returns once the client *task* is spawned; the tunnel
//! may still fail later (relay unreachable, handshake rejected). That terminal
//! outcome is reported through the [`ExitReporter`] the caller hands in, so the
//! HTTP layer can flip `running` back off and surface the cause.

use tokio::sync::broadcast;

use crate::domain::{RelayConnection, TunnelSettings};

/// The terminal status of an embedded relay client, reported once its task
/// exits.
#[derive(Debug)]
pub enum TunnelStatus {
    /// The client exited with an error after launch (relay unreachable,
    /// handshake rejected, transport error). Carries the original error so the
    /// consumer decides how to render it (the HTTP layer stringifies it only
    /// when folding it into the wire `error` field).
    Failed(anyhow::Error),
    /// The client exited cleanly — after a shutdown signal, or because the
    /// relay closed the session without an error.
    Stopped,
}

/// A one-shot sink the embedded client uses to report why it exited, called at
/// most once when the client task exits. The HTTP state machine builds one that
/// folds the outcome back into the live runtime; tests build ones that record
/// it.
pub type ExitReporter = Box<dyn FnOnce(TunnelStatus) + Send>;

/// Brings the tunnel up. The trait is a test seam; the real impl embeds
/// rathole.
pub trait RelayClient: Send + Sync {
    /// Start forwarding `local_addr` to the relay per `settings`. Returns a
    /// handle that tears the tunnel down on [`RelayHandle::stop`], or an error
    /// if the relay isn't configured or the client couldn't launch.
    ///
    /// Returning `Ok` only means the client task was spawned. A *post-launch*
    /// exit (clean or failed) is delivered later through `on_exit`.
    fn start(
        &self,
        settings: &TunnelSettings,
        local_addr: &str,
        on_exit: ExitReporter,
    ) -> anyhow::Result<RelayHandle>;
}

/// A running tunnel. Dropping or [`stop`](RelayHandle::stop)ping it signals the
/// embedded rathole client to shut down; the retained temp config file is
/// deleted on drop.
#[derive(Debug)]
pub struct RelayHandle {
    shutdown: broadcast::Sender<bool>,
    // Held for the tunnel's lifetime: rathole reads the config from this path,
    // and dropping the handle deletes it.
    _config: Option<tempfile::NamedTempFile>,
}

impl RelayHandle {
    /// Signal the embedded client to shut down. A closed receiver just means it
    /// already exited.
    pub fn stop(&self) {
        let _ = self.shutdown.send(true);
    }

    /// A handle with no backing process, for tests that exercise the state
    /// machine without launching rathole.
    #[cfg(test)]
    pub(crate) fn test_handle() -> Self {
        Self {
            shutdown: broadcast::channel(1).0,
            _config: None,
        }
    }
}

/// The real client: renders a rathole client config and runs an embedded
/// rathole client on the ambient tokio runtime.
#[derive(Default)]
pub struct RatholeRelayClient;

impl RatholeRelayClient {
    pub fn new() -> Self {
        Self
    }
}

impl RelayClient for RatholeRelayClient {
    fn start(
        &self,
        settings: &TunnelSettings,
        local_addr: &str,
        on_exit: ExitReporter,
    ) -> anyhow::Result<RelayHandle> {
        let relay = settings.relay_connection().ok_or_else(|| {
            anyhow::anyhow!(
                "tunnel relay is not configured (set the relay address, token, and public key)"
            )
        })?;

        let toml = render_client_toml(&relay, local_addr);
        let mut file = tempfile::Builder::new()
            .prefix("wildflower-tunnel-client")
            .suffix(".toml")
            .tempfile()
            .map_err(|e| anyhow::anyhow!("failed to create tunnel client config file: {e}"))?;
        std::io::Write::write_all(&mut file, toml.as_bytes())
            .map_err(|e| anyhow::anyhow!("failed to write tunnel client config: {e}"))?;
        let path = file.path().to_path_buf();

        // rathole must run inside a tokio runtime; we're called from an async
        // HTTP handler (or setup), so a handle is available.
        let handle = tokio::runtime::Handle::try_current()
            .map_err(|_| anyhow::anyhow!("tunnel client must be started within a tokio runtime"))?;

        let (shutdown_tx, shutdown_rx) = broadcast::channel(1);
        let cli = rathole::Cli {
            config_path: Some(path),
            client: true,
            ..Default::default()
        };
        handle.spawn(async move {
            let status = match rathole::run(cli, shutdown_rx).await {
                Ok(()) => TunnelStatus::Stopped,
                Err(error) => {
                    // Post-launch failure (relay unreachable, handshake
                    // rejected). Logged here and reported back so the HTTP
                    // `error` field reflects it.
                    tracing::error!(?error, "embedded rathole client exited with error");
                    TunnelStatus::Failed(error)
                }
            };
            on_exit(status);
        });

        Ok(RelayHandle {
            shutdown: shutdown_tx,
            _config: Some(file),
        })
    }
}

/// Render a rathole client config (TOML) for `relay`, forwarding `local_addr`.
/// Hand-rendered rather than serialized from rathole's `Config` (which can't be
/// cleanly re-serialized); a golden test parses the output back through
/// `rathole::Config::from_file` to catch drift.
fn render_client_toml(relay: &RelayConnection, local_addr: &str) -> String {
    let RelayConnection {
        remote_addr,
        token,
        public_key,
        service_name,
    } = relay;
    format!(
        "[client]\n\
         remote_addr = \"{remote_addr}\"\n\
         default_token = \"{token}\"\n\
         \n\
         [client.transport]\n\
         type = \"noise\"\n\
         \n\
         [client.transport.noise]\n\
         remote_public_key = \"{public_key}\"\n\
         \n\
         [client.services.{service_name}]\n\
         type = \"tcp\"\n\
         local_addr = \"{local_addr}\"\n"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The rendered client config must parse as a valid rathole *client* config
    /// through the same path runtime uses — guards against TOML drift.
    #[tokio::test]
    async fn rendered_client_toml_is_a_valid_rathole_client_config() {
        let relay = RelayConnection {
            remote_addr: "relay.example.com:2333".into(),
            token: "shared-secret".into(),
            public_key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=".into(),
            service_name: "wildflower-device-1".into(),
        };
        let toml = render_client_toml(&relay, "127.0.0.1:8080");
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("client.toml");
        std::fs::write(&path, &toml).expect("write client toml");
        let config = rathole::Config::from_file(&path)
            .await
            .expect("rendered client config must parse");
        let client = config.client.expect("must define a [client] section");
        assert!(
            config.server.is_none(),
            "client config must not be a server"
        );
        assert!(client.services.contains_key("wildflower-device-1"));
    }

    #[test]
    fn start_errors_when_relay_unconfigured() {
        let err = RatholeRelayClient::new()
            .start(
                &TunnelSettings::default(),
                "127.0.0.1:8080",
                Box::new(|_| {}),
            )
            .unwrap_err();
        assert!(err.to_string().contains("not configured"));
    }
}
