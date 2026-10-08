//! The embedded rathole client that dials the relay.
//!
//! [`RelayClient`] is a one-attempt seam: `run_once` brings up a single rathole
//! client and returns when it exits. The [`TunnelDaemon`](crate::domain::TunnelDaemon)
//! supervisor owns the retry/backoff loop and cancellation, so this layer holds
//! no run lifecycle of its own. The trait exists so the supervisor can be tested
//! against a fake instead of a live relay.
//!
//! rathole's own `Config` re-serializes the token as a masked `***`, so we
//! render the client config from our own typed structs with [`toml`] (escaping
//! handled by construction) and parse that. The client runs with a visitor
//! queue: rather than connecting each visitor to a local address, it queues
//! the visitor's stream, and we hand it to the caller's sender.

use std::collections::BTreeMap;

use crate::domain::{RelayClient, RelaySettings, TunnelStream};
use anyhow::Context;
use rathole::ClientServiceEvent;
use rathole_settings_rust::{NoisePattern, Transport};
use serde::Serialize;
use tokio::sync::{broadcast, mpsc};
use tokio::task::JoinSet;
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
        tunnel_stream_sender: mpsc::Sender<TunnelStream>,
        cancel: CancellationToken,
    ) -> anyhow::Result<()> {
        let config: rathole::Config = render_client_toml(relay)?
            .parse()
            .context("rendered tunnel client config is invalid")?;

        // rathole's client stops, tearing down its control channel, when
        // `shutdown_tx` sends or drops. A drop logs `Unable to listen for
        // shutdown signal: channel closed` from rathole's `client.run`; that
        // is a teardown *symptom*, not a fault: when a tunnel flaps, chase what
        // cancelled `run_once` (the daemon dropping — see
        // `domain::tunnel_daemon`), not the rathole error.
        let (shutdown_tx, shutdown_rx) = broadcast::channel(1);
        // The one service never changes while the client runs, so no config
        // change is ever sent; rathole stops listening for them once this
        // sender is dropped.
        let (_, config_change_rx) = mpsc::channel(1);
        let (service_event_tx, service_event_rx) = mpsc::unbounded_channel();
        let client = rathole::run_client_with_visitor_queue(
            config,
            shutdown_rx,
            config_change_rx,
            service_event_tx,
        );
        // The service events end once the client has returned and stopped its
        // service.
        let run = async {
            let (result, ()) = tokio::join!(
                client,
                hand_over_tunnel_streams(service_event_rx, tunnel_stream_sender)
            );
            result
        };
        tokio::pin!(run);

        // Cancellation asks rathole to shut down, then waits for it to drain.
        tokio::select! {
            res = &mut run => {
                // rathole's client returned without us cancelling — the relay
                // dropped us, or rathole tore itself down. This is the
                // unexpected path when the tunnel should be staying up.
                tracing::warn!(?res, "rathole client returned on its own (no cancel)");
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

/// Send each visitor stream of each TCP service the client starts to
/// `tunnel_stream_sender`, until the client stops reporting services.
///
/// Each service's streams are sent from a task of their own, since a service's
/// queue ends only after its in-flight data channels, which the client's
/// return need not wait for. The tasks end with this call, which `run_once`
/// awaits, so a dial's streams are never handed over once it is done.
async fn hand_over_tunnel_streams(
    mut service_events: mpsc::UnboundedReceiver<ClientServiceEvent>,
    tunnel_stream_sender: mpsc::Sender<TunnelStream>,
) {
    let mut services = JoinSet::new();
    loop {
        tokio::select! {
            service_event = service_events.recv() => match service_event {
                Some(ClientServiceEvent::TcpStarted {
                    mut visitor_stream_rx,
                    ..
                }) => {
                    let tunnel_stream_sender = tunnel_stream_sender.clone();
                    services.spawn(async move {
                        while let Some(tunnel_stream) = visitor_stream_rx.recv().await {
                            if tunnel_stream_sender.send(tunnel_stream).await.is_err() {
                                // The server stopped taking tunnel connections.
                                return;
                            }
                        }
                    });
                }
                Some(_) => {}
                // Dropping `services` aborts the tasks still running.
                None => return,
            },
            // Reap the services whose queues have ended.
            Some(_) = services.join_next() => {}
        }
    }
}

/// Render a rathole client config (TOML) from our own typed structs. We don't
/// reuse rathole's `Config` because its `MaskedString` token serializes as
/// `***`; serializing our own structs keeps the real token and escapes every
/// value (including the `service_name` table key) by construction. The
/// service's `local_addr` is empty: its visitor streams are queued for us
/// instead.
fn render_client_toml(relay: &RelaySettings) -> anyhow::Result<String> {
    let mut services = BTreeMap::new();
    services.insert(
        relay.service_name.as_str(),
        ServiceSection {
            service_type: "tcp",
            local_addr: "",
        },
    );

    let config = ClientToml {
        client: ClientSection {
            remote_addr: &relay.remote_addr,
            default_token: &relay.token,
            transport: TransportSection {
                transport_type: Transport::Noise,
                noise: NoiseSection {
                    pattern: NoisePattern::Nk25519ChaChaPolyBlake2s,
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
    transport_type: Transport,
    noise: NoiseSection<'a>,
}

#[derive(Serialize)]
struct NoiseSection<'a> {
    pattern: NoisePattern,
    remote_public_key: &'a str,
}

#[derive(Serialize)]
struct ServiceSection<'a> {
    #[serde(rename = "type")]
    service_type: &'a str,
    /// rathole requires one, but a client run with a visitor queue never
    /// connects to it, so it is left empty.
    local_addr: &'a str,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The rendered client config must parse as a valid rathole *client* config
    /// through the same path runtime uses — guards against TOML drift.
    #[test]
    fn rendered_client_toml_is_a_valid_rathole_client_config() {
        let relay = RelaySettings {
            remote_addr: "relay.example.com:2333".into(),
            token: "shared-secret".into(),
            public_key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=".into(),
            service_name: "wildflower-device-1".into(),
        };
        let config: rathole::Config = render_client_toml(&relay)
            .expect("render")
            .parse()
            .expect("rendered client config must parse");
        let client = config.client.expect("must define a [client] section");
        assert!(
            config.server.is_none(),
            "client config must not be a server"
        );
        // The service has no local address: its visitor streams are queued.
        assert_eq!(
            client
                .services
                .get("wildflower-device-1")
                .map(|service| service.local_addr.as_str()),
            Some("")
        );
    }

    /// A device that has only its tunnel name and token gets a working client
    /// config from the relay's `GET /rathole` response.
    #[test]
    fn client_toml_from_public_rathole_settings_is_a_valid_rathole_client_config() {
        let response = r#"{
            "remote_addr": "relay.example.com:2333",
            "transport": "noise",
            "noise_pattern": "Noise_NK_25519_ChaChaPoly_BLAKE2s",
            "public_key": "24cva5FBfzidZjaSQl4dyqGfuzDspKWe+koxXAVIQkM=",
            "domain": "relay.example.com"
        }"#;
        let relay = RelaySettings::from_public_rathole_settings(
            serde_json::from_str(response).expect("GET /rathole response"),
            "abc123".into(),
            "tunnel-token".into(),
        );
        let rendered = render_client_toml(&relay).expect("render");
        let client = rendered
            .parse::<rathole::Config>()
            .expect("client config must parse")
            .client
            .expect("[client]");
        assert_eq!(client.remote_addr, "relay.example.com:2333");
        let noise = client.transport.noise.expect("[client.transport.noise]");
        assert_eq!(noise.pattern, "Noise_NK_25519_ChaChaPoly_BLAKE2s");
        assert_eq!(
            noise.remote_public_key.as_deref(),
            Some("24cva5FBfzidZjaSQl4dyqGfuzDspKWe+koxXAVIQkM=")
        );
        assert_eq!(client.services.len(), 1);
        assert_eq!(client.services["abc123"].local_addr, "");
        assert!(rendered.contains(r#"default_token = "tunnel-token""#));
    }

    /// Adversarial field contents that would break a hand-formatted config —
    /// quotes, brackets, newlines — must still round-trip through rathole's
    /// parser, proving the typed serializer escapes them.
    #[test]
    fn rendered_toml_escapes_hostile_field_contents() {
        let relay = RelaySettings {
            remote_addr: "relay:2333".into(),
            token: "tok\"with\nquote".into(),
            public_key: "key".into(),
            service_name: "svc\"]\n[client.services.evil".into(),
        };
        let config: rathole::Config = render_client_toml(&relay)
            .expect("render")
            .parse()
            .expect("hostile values must still parse, not inject");
        let client = config.client.expect("client section");
        // The service name survives verbatim as a single key — no injected service.
        assert_eq!(client.services.len(), 1);
        assert!(client
            .services
            .contains_key("svc\"]\n[client.services.evil"));
    }

    /// Each TCP service's visitor streams go to the sender, in order, and the
    /// hand-over, with every service's, ends with the client's service
    /// events.
    #[tokio::test]
    async fn each_visitor_stream_is_handed_over() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let (service_event_tx, service_event_rx) = mpsc::unbounded_channel();
        let (visitor_stream_tx, visitor_stream_rx) = mpsc::channel(2);
        let (tunnel_stream_sender, mut tunnel_streams) = mpsc::channel(2);
        service_event_tx
            .send(ClientServiceEvent::TcpStarted {
                config: rathole::ClientServiceConfig::with_name("dev1"),
                visitor_stream_rx,
            })
            .expect("the hand-over takes events");
        let hand_over = tokio::spawn(hand_over_tunnel_streams(
            service_event_rx,
            tunnel_stream_sender,
        ));

        for visitor_bytes in [b"first", b"other"] {
            let (mut visitor, visitor_stream) = tokio::io::duplex(64);
            visitor.write_all(visitor_bytes).await.expect("write");
            visitor_stream_tx
                .send(Box::new(visitor_stream))
                .await
                .expect("the hand-over takes visitor streams");
            let mut tunnel_stream = tunnel_streams.recv().await.expect("handed over");
            let mut received = [0; 5];
            tunnel_stream.read_exact(&mut received).await.expect("read");
            assert_eq!(&received, visitor_bytes);
        }
        // The client returning drops its events sender: the hand-over ends,
        // and with it the service's, though its queue is still open.
        drop(service_event_tx);
        hand_over.await.expect("the hand-over doesn't panic");
        assert!(tunnel_streams.recv().await.is_none());
        drop(visitor_stream_tx);
    }
}
