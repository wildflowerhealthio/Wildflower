//! The embedded rathole client that dials the relay.
//!
//! [`RelayClient`] is a one-attempt seam: `run_once` brings up a single rathole
//! client and returns when it exits. The [`http::TunnelState`](crate::http)
//! supervisor owns the retry/backoff loop and cancellation, so this layer holds
//! no run lifecycle of its own. The trait exists so the supervisor can be tested
//! against a fake instead of a live relay.
//!
//! rathole's public API only accepts a config *file* path, and its own `Config`
//! re-serializes the token as a masked `***`, so we render the client config
//! from our own typed structs with [`toml`] (escaping handled by construction)
//! to a temp file that lives for the duration of the attempt.

use std::collections::BTreeMap;

use crate::domain::{RelayClient, RelaySettings};
use anyhow::Context;
use serde::Serialize;
use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;

/// The real client: renders a rathole client config and runs an embedded
/// rathole client on the ambient tokio runtime.
#[derive(Default)]
pub struct RatholeRelayClient;

impl RatholeRelayClient {
    #[must_use]
    pub fn new() -> Self {
        Self
    }
}

#[async_trait::async_trait]
impl RelayClient for RatholeRelayClient {
    async fn run_once(
        &self,
        relay: &RelaySettings,
        local_addr: &str,
        cancel: CancellationToken,
    ) -> anyhow::Result<()> {
        let rendered = render_client_toml(relay, local_addr)?;
        let mut file = tempfile::Builder::new()
            .prefix("wildflower-tunnel-client")
            .suffix(".toml")
            .tempfile()
            .context("failed to create tunnel client config file")?;
        std::io::Write::write_all(&mut file, rendered.as_bytes())
            .context("failed to write tunnel client config")?;

        let cli = rathole::Cli {
            config_path: Some(file.path().to_path_buf()),
            client: true,
            ..Default::default()
        };
        let (shutdown_tx, shutdown_rx) = broadcast::channel(1);
        let run = rathole::run(cli, shutdown_rx);
        tokio::pin!(run);

        // Cancellation asks rathole to shut down, then waits for it to drain so
        // the temp config file (still in scope until this fn returns) isn't
        // dropped out from under it.
        tokio::select! {
            res = &mut run => {
                // rathole's `run` returned without us cancelling — the relay
                // dropped us, or rathole tore itself down (e.g. its config
                // watcher / shutdown plumbing). This is the unexpected path
                // when the tunnel should be staying up.
                tracing::warn!(?res, "rathole run() returned on its own (no cancel)");
                res
            }
            () = cancel.cancelled() => {
                tracing::info!("rathole: cancellation requested, sending graceful shutdown");
                let _ = shutdown_tx.send(true);
                (&mut run).await
            }
        }
    }
}

/// Render a rathole client config (TOML) from our own typed structs. We don't
/// reuse rathole's `Config` because its `MaskedString` token serializes as
/// `***`; serializing our own structs keeps the real token and escapes every
/// value (including the `service_name` table key) by construction.
fn render_client_toml(relay: &RelaySettings, local_addr: &str) -> anyhow::Result<String> {
    let mut services = BTreeMap::new();
    services.insert(
        relay.service_name.as_str(),
        ServiceSection {
            service_type: "tcp",
            local_addr,
        },
    );

    let config = ClientToml {
        client: ClientSection {
            remote_addr: &relay.remote_addr,
            default_token: &relay.token,
            transport: TransportSection {
                transport_type: "noise",
                noise: NoiseSection {
                    remote_public_key: &relay.public_key,
                },
            },
            services,
        },
    };
    toml::to_string(&config).context("failed to render rathole client config")
}

// Scalars are declared before sub-tables in each struct so the `toml`
// serializer (which rejects a value emitted after a table) emits them in a
// valid order.
#[derive(Serialize)]
struct ClientToml<'a> {
    client: ClientSection<'a>,
}

#[derive(Serialize)]
struct ClientSection<'a> {
    remote_addr: &'a str,
    default_token: &'a str,
    transport: TransportSection<'a>,
    services: BTreeMap<&'a str, ServiceSection<'a>>,
}

#[derive(Serialize)]
struct TransportSection<'a> {
    #[serde(rename = "type")]
    transport_type: &'a str,
    noise: NoiseSection<'a>,
}

#[derive(Serialize)]
struct NoiseSection<'a> {
    remote_public_key: &'a str,
}

#[derive(Serialize)]
struct ServiceSection<'a> {
    #[serde(rename = "type")]
    service_type: &'a str,
    local_addr: &'a str,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The rendered client config must parse as a valid rathole *client* config
    /// through the same path runtime uses — guards against TOML drift.
    #[tokio::test]
    async fn rendered_client_toml_is_a_valid_rathole_client_config() {
        let relay = RelaySettings {
            remote_addr: "relay.example.com:2333".into(),
            token: "shared-secret".into(),
            public_key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=".into(),
            service_name: "wildflower-device-1".into(),
        };
        let rendered = render_client_toml(&relay, "127.0.0.1:8080").expect("render");
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("client.toml");
        std::fs::write(&path, &rendered).expect("write client toml");
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

    /// Adversarial field contents that would break a hand-formatted config —
    /// quotes, brackets, newlines — must still round-trip through rathole's
    /// parser, proving the typed serializer escapes them.
    #[tokio::test]
    async fn rendered_toml_escapes_hostile_field_contents() {
        let relay = RelaySettings {
            remote_addr: "relay:2333".into(),
            token: "tok\"with\nquote".into(),
            public_key: "key".into(),
            service_name: "svc\"]\n[client.services.evil".into(),
        };
        let rendered = render_client_toml(&relay, "127.0.0.1:8080").expect("render");
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("client.toml");
        std::fs::write(&path, &rendered).expect("write");
        let config = rathole::Config::from_file(&path)
            .await
            .expect("hostile values must still parse, not inject");
        let client = config.client.expect("client section");
        // The service name survives verbatim as a single key — no injected service.
        assert_eq!(client.services.len(), 1);
        assert!(client
            .services
            .contains_key("svc\"]\n[client.services.evil"));
    }
}
