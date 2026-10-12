//! The embedded rathole client that dials the relay.
//!
//! [`RelayClient`] is a one-attempt seam: `run_once` brings up a single rathole
//! client and returns when its control channel first fails, or when it is
//! cancelled. rathole would retry a failed control channel itself; `run_once`
//! shuts the client down instead, so the
//! [`TunnelDaemon`](crate::domain::TunnelDaemon) supervisor owns the
//! retry/backoff loop and cancellation, and this layer holds no run lifecycle
//! of its own. The trait exists so the supervisor can be tested against a fake
//! instead of a live relay.
//!
//! rathole's own `Config` re-serializes the token as a masked `***`, so we
//! render the client config from our own typed structs with [`toml`] (escaping
//! handled by construction) and parse that. The client runs with a visitor
//! queue: rather than connecting each visitor to a local address, it queues
//! the visitor's stream, and we hand it to the caller's sender.

use std::collections::BTreeMap;

use crate::domain::{DialFailure, RelayClient, RelaySettings, TunnelStream};
use anyhow::Context;
use rathole::{ClientServiceEvent, ControlChannelError, ControlChannelState};
use serde::Serialize;
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;
use wildflowerhealthio_rathole_settings::{NoisePattern, Transport};

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
        tunnel_stream_tx: mpsc::Sender<TunnelStream>,
        connected_tx: oneshot::Sender<()>,
        cancel: CancellationToken,
    ) -> Result<(), DialFailure> {
        let config: rathole::Config = render_client_toml(relay)
            .and_then(|toml| {
                toml.parse()
                    .context("rendered tunnel client config is invalid")
            })
            .map_err(DialFailure::Dropped)?;

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
        let (control_channel_state_tx, control_channel_state_rx) = mpsc::unbounded_channel();
        let client = rathole::run_client_with_visitor_queue(
            config,
            shutdown_rx,
            config_change_rx,
            service_event_tx,
            control_channel_state_tx,
        );
        // The service events end once the client has returned and stopped its
        // service.
        let run = async {
            let (result, ()) = tokio::join!(
                client,
                hand_over_tunnel_streams(service_event_rx, tunnel_stream_tx)
            );
            result
        };
        tokio::pin!(run);

        // The first failure of the control channel, or a cancel, asks rathole
        // to shut down, then waits for it to drain.
        let dial_result = tokio::select! {
            res = &mut run => {
                // rathole's client returned without being shut down: it
                // couldn't start, e.g. its transport couldn't be built from
                // the config. The daemon logs the failure.
                let error = match res {
                    Err(error) => error,
                    Ok(()) => anyhow::anyhow!("rathole client returned on its own"),
                };
                return Err(DialFailure::Dropped(error));
            }
            dial_failure = until_disconnected(control_channel_state_rx, connected_tx) => {
                Err(dial_failure)
            }
            () = cancel.cancelled() => {
                tracing::info!("rathole: cancellation requested, sending graceful shutdown");
                Ok(())
            }
        };
        let _ = shutdown_tx.send(true);
        if let Err(error) = (&mut run).await {
            tracing::warn!(error = %format!("{error:#}"), "rathole client failed while shutting down");
        }
        dial_result
    }
}

/// Watch the client's control channel: send on `connected_tx` once the relay
/// accepts it, and resolve with why it failed the first time it does. The
/// daemon logs each dial's outcome; each change is only a debug event here.
/// Pending once the client stops reporting.
async fn until_disconnected(
    mut control_channel_state_rx: mpsc::UnboundedReceiver<ControlChannelState>,
    connected_tx: oneshot::Sender<()>,
) -> DialFailure {
    let mut connected_tx = Some(connected_tx);
    while let Some(control_channel_state) = control_channel_state_rx.recv().await {
        match control_channel_state {
            ControlChannelState::Connected { name } => {
                tracing::debug!(service = %name, "rathole: control channel established");
                if let Some(connected_tx) = connected_tx.take() {
                    let _ = connected_tx.send(());
                }
            }
            ControlChannelState::Disconnected { name, error, .. } => {
                tracing::debug!(service = %name, "rathole: control channel failed: {error:#}");
                return dial_failure_of(error);
            }
        }
    }
    // The client has stopped its control channel: it returned, which `run`
    // reports.
    std::future::pending().await
}

/// The [`DialFailure`] a control channel's `error` ends the dial with.
fn dial_failure_of(error: ControlChannelError) -> DialFailure {
    match error {
        ControlChannelError::AuthFailed => DialFailure::TokenRejected,
        ControlChannelError::ServiceNotExist => DialFailure::TunnelUnknown,
        ControlChannelError::Failed(error) => DialFailure::Dropped(error),
    }
}

/// Send each visitor stream of each TCP service the client starts to
/// `tunnel_stream_tx`, until the client stops reporting services.
///
/// Each service's streams are sent from a task of their own, since a service's
/// queue ends only after its in-flight data channels, which the client's
/// return need not wait for. The tasks end with this call, which `run_once`
/// awaits, so a dial's streams are never handed over once it is done.
async fn hand_over_tunnel_streams(
    mut service_event_rx: mpsc::UnboundedReceiver<ClientServiceEvent>,
    tunnel_stream_tx: mpsc::Sender<TunnelStream>,
) {
    let mut services = JoinSet::new();
    loop {
        tokio::select! {
            service_event = service_event_rx.recv() => match service_event {
                Some(ClientServiceEvent::TcpStarted {
                    mut visitor_stream_rx,
                    ..
                }) => {
                    let tunnel_stream_tx = tunnel_stream_tx.clone();
                    services.spawn(async move {
                        while let Some(tunnel_stream) = visitor_stream_rx.recv().await {
                            if tunnel_stream_tx.send(tunnel_stream).await.is_err() {
                                // The server stopped taking tunnel connections.
                                return;
                            }
                        }
                    });
                }
                Some(_) => {}
                None => {
                    // Abort the services still sending, and wait for them to
                    // stop, so none sends once this returns.
                    services.shutdown().await;
                    return;
                }
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
    use std::time::Duration;

    use wildflowerhealthio_kitchen_sink::loopback_port::free_loopback_port;

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

    #[test]
    fn each_control_channel_error_is_its_dial_failure() {
        assert!(matches!(
            dial_failure_of(ControlChannelError::AuthFailed),
            DialFailure::TokenRejected
        ));
        assert!(matches!(
            dial_failure_of(ControlChannelError::ServiceNotExist),
            DialFailure::TunnelUnknown
        ));
        assert!(matches!(
            dial_failure_of(ControlChannelError::Failed(anyhow::anyhow!("heartbeat timed out"))),
            DialFailure::Dropped(error) if error.to_string() == "heartbeat timed out"
        ));
    }

    /// The control channel connecting is signalled, and its first failure
    /// ends the watch, with why.
    #[tokio::test]
    async fn the_watch_signals_connected_and_ends_on_the_first_failure() {
        let (control_channel_state_tx, control_channel_state_rx) = mpsc::unbounded_channel();
        let (connected_tx, connected_rx) = oneshot::channel();
        let watch = tokio::spawn(until_disconnected(control_channel_state_rx, connected_tx));

        control_channel_state_tx
            .send(ControlChannelState::Connected {
                name: "dev1".into(),
            })
            .expect("the watch takes states");
        connected_rx.await.expect("connected is signalled");
        control_channel_state_tx
            .send(ControlChannelState::Disconnected {
                name: "dev1".into(),
                error: ControlChannelError::AuthFailed,
                retry_in: Duration::from_secs(1),
            })
            .expect("the watch takes states");
        let dial_failure = watch.await.expect("the watch doesn't panic");
        assert!(
            matches!(dial_failure, DialFailure::TokenRejected),
            "{dial_failure:?}"
        );
    }

    /// The noise key pair the stand-in relay serves with, from
    /// `rathole --genkey` (rathole 0.5.0).
    const RELAY_PRIVATE_KEY: &str = "HY1kqeX1WAAysgpriYop7NW/Yw7KAO//EdEBs8qxv7I=";
    const RELAY_PUBLIC_KEY: &str = "24cva5FBfzidZjaSQl4dyqGfuzDspKWe+koxXAVIQkM=";

    /// How long a dial against the stand-in relay may take to end.
    const DIAL_TIMEOUT: Duration = Duration::from_secs(10);

    /// An address on loopback nothing listens on.
    fn free_addr() -> String {
        format!("127.0.0.1:{}", free_loopback_port())
    }

    /// A rathole server on loopback holding the one tunnel `service_name`
    /// with `token`, standing in for the relay, until the returned sender
    /// sends or drops; and the settings a device dials it with, for the
    /// tunnel `dialed_service_name` and `dialed_token`.
    async fn stand_in_relay(
        service_name: &str,
        token: &str,
        dialed_service_name: &str,
        dialed_token: &str,
    ) -> (
        broadcast::Sender<bool>,
        tokio::task::JoinHandle<anyhow::Result<()>>,
        RelaySettings,
    ) {
        let control_addr = free_addr();
        let config: rathole::Config = format!(
            "[server]\nbind_addr = \"{control_addr}\"\n\
             [server.transport]\ntype = \"noise\"\n\
             [server.transport.noise]\nlocal_private_key = \"{RELAY_PRIVATE_KEY}\"\n\
             [server.services.{service_name}]\nbind_addr = \"{visitor_addr}\"\ntoken = \"{token}\"\n",
            visitor_addr = free_addr(),
        )
        .parse()
        .expect("server config");
        let (shutdown_tx, shutdown_rx) = broadcast::channel(1);
        let (_, config_change_rx) = mpsc::channel(1);
        let relay = tokio::spawn(rathole::run_server(config, shutdown_rx, config_change_rx));
        // Wait for it to listen, so that the first dial reaches it; bounded,
        // so a relay that couldn't bind fails the test rather than hangs it.
        tokio::time::timeout(DIAL_TIMEOUT, async {
            while tokio::net::TcpStream::connect(&control_addr).await.is_err() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the stand-in relay listens within the bound");
        let relay_settings = RelaySettings {
            remote_addr: control_addr,
            token: dialed_token.into(),
            public_key: RELAY_PUBLIC_KEY.into(),
            service_name: dialed_service_name.into(),
        };
        (shutdown_tx, relay, relay_settings)
    }

    /// One dial of `relay_settings`, cancelled by `cancel`, and whether it
    /// signalled connected.
    async fn dial(
        relay_settings: &RelaySettings,
        cancel: CancellationToken,
    ) -> (Result<(), DialFailure>, bool) {
        let (connected_tx, connected_rx) = oneshot::channel();
        let dial_result = tokio::time::timeout(
            DIAL_TIMEOUT,
            RatholeRelayClient::new().run_once(
                relay_settings,
                mpsc::channel(1).0,
                connected_tx,
                cancel,
            ),
        )
        .await
        .expect("the dial ends within the bound");
        (dial_result, connected_rx.await.is_ok())
    }

    #[tokio::test]
    async fn a_wrong_token_is_rejected() {
        let (_relay_shutdown_tx, _relay, relay_settings) =
            stand_in_relay("dev1", "token", "dev1", "wrong-token").await;
        let (dial_result, connected) = dial(&relay_settings, CancellationToken::new()).await;
        assert!(
            matches!(dial_result, Err(DialFailure::TokenRejected)),
            "{dial_result:?}"
        );
        assert!(!connected, "a rejected dial never connected");
    }

    #[tokio::test]
    async fn an_unknown_tunnel_is_unknown() {
        let (_relay_shutdown_tx, _relay, relay_settings) =
            stand_in_relay("other", "token", "dev1", "token").await;
        let (dial_result, connected) = dial(&relay_settings, CancellationToken::new()).await;
        assert!(
            matches!(dial_result, Err(DialFailure::TunnelUnknown)),
            "{dial_result:?}"
        );
        assert!(!connected, "a refused dial never connected");
    }

    #[tokio::test]
    async fn an_unreachable_relay_drops_the_dial() {
        let relay_settings = RelaySettings {
            remote_addr: free_addr(),
            token: "token".into(),
            public_key: RELAY_PUBLIC_KEY.into(),
            service_name: "dev1".into(),
        };
        let (dial_result, connected) = dial(&relay_settings, CancellationToken::new()).await;
        assert!(
            matches!(dial_result, Err(DialFailure::Dropped(_))),
            "{dial_result:?}"
        );
        assert!(!connected);
    }

    /// The relay accepting the tunnel is signalled, and the relay going away
    /// ends the dial, rather than rathole retrying it.
    #[tokio::test]
    async fn a_connected_dial_ends_when_the_relay_goes_away() {
        let (relay_shutdown_tx, relay, relay_settings) =
            stand_in_relay("dev1", "token", "dev1", "token").await;
        let (connected_tx, connected_rx) = oneshot::channel();
        let dial = tokio::spawn(async move {
            RatholeRelayClient::new()
                .run_once(
                    &relay_settings,
                    mpsc::channel(1).0,
                    connected_tx,
                    CancellationToken::new(),
                )
                .await
        });
        tokio::time::timeout(DIAL_TIMEOUT, connected_rx)
            .await
            .expect("connected within the bound")
            .expect("connected is signalled");

        relay_shutdown_tx.send(true).expect("the relay is running");
        relay
            .await
            .expect("the relay doesn't panic")
            .expect("the relay shuts down");
        let dial_result = tokio::time::timeout(DIAL_TIMEOUT, dial)
            .await
            .expect("the dial ends within the bound")
            .expect("the dial doesn't panic");
        assert!(
            matches!(dial_result, Err(DialFailure::Dropped(_))),
            "{dial_result:?}"
        );
    }

    #[tokio::test]
    async fn a_cancelled_dial_resolves_ok() {
        let (_relay_shutdown_tx, _relay, relay_settings) =
            stand_in_relay("dev1", "token", "dev1", "token").await;
        let cancel = CancellationToken::new();
        let (connected_tx, connected_rx) = oneshot::channel();
        let dial = tokio::spawn({
            let cancel = cancel.clone();
            async move {
                RatholeRelayClient::new()
                    .run_once(&relay_settings, mpsc::channel(1).0, connected_tx, cancel)
                    .await
            }
        });
        tokio::time::timeout(DIAL_TIMEOUT, connected_rx)
            .await
            .expect("connected within the bound")
            .expect("connected is signalled");

        cancel.cancel();
        let dial_result = tokio::time::timeout(DIAL_TIMEOUT, dial)
            .await
            .expect("the dial ends within the bound")
            .expect("the dial doesn't panic");
        assert!(dial_result.is_ok(), "{dial_result:?}");
    }

    /// Each TCP service's visitor streams go to the sender, in order, and the
    /// hand-over, with every service's, ends with the client's service
    /// events.
    #[tokio::test]
    async fn each_visitor_stream_is_handed_over() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let (service_event_tx, service_event_rx) = mpsc::unbounded_channel();
        let (visitor_stream_tx, visitor_stream_rx) = mpsc::channel(2);
        let (tunnel_stream_tx, mut tunnel_stream_rx) = mpsc::channel(2);
        service_event_tx
            .send(ClientServiceEvent::TcpStarted {
                config: rathole::ClientServiceConfig::with_name("dev1"),
                visitor_stream_rx,
            })
            .expect("the hand-over takes events");
        let hand_over = tokio::spawn(hand_over_tunnel_streams(service_event_rx, tunnel_stream_tx));

        for visitor_bytes in [b"first", b"other"] {
            let (mut visitor, visitor_stream) = tokio::io::duplex(64);
            visitor.write_all(visitor_bytes).await.expect("write");
            visitor_stream_tx
                .send(Box::new(visitor_stream))
                .await
                .expect("the hand-over takes visitor streams");
            let mut tunnel_stream = tunnel_stream_rx.recv().await.expect("handed over");
            let mut received = [0; 5];
            tunnel_stream.read_exact(&mut received).await.expect("read");
            assert_eq!(&received, visitor_bytes);
        }
        // The client returning drops its events sender: the hand-over ends,
        // and with it the service's, though its queue is still open.
        drop(service_event_tx);
        hand_over.await.expect("the hand-over doesn't panic");
        assert!(tunnel_stream_rx.recv().await.is_none());
        drop(visitor_stream_tx);
    }
}
