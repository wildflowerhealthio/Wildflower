//! Fixtures shared across the relay's unit tests: the settings a test relay
//! runs with, the [`TunnelRegistry`] it builds from them over a fresh state
//! directory, the capability bindings built from that registry, and a
//! rathole client standing in for a device.

use std::sync::Arc;
use std::time::Duration;

use rathole::{AsyncStream, ClientServiceEvent};
use tokio::sync::{broadcast, mpsc};

use crate::live_bindings::state::{RatholeFeed, TunnelRegistry};
use crate::live_bindings::AdminCapability;
use crate::settings::RelaySettings;
use crate::tunnels::Tunnels;

const NOISE_PRIVATE_KEY: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

/// Settings for `relay.example.com` with the given admin key, keeping state
/// in `state_dir`.
pub(crate) fn settings(state_dir: &std::path::Path, admin_key: Option<&str>) -> RelaySettings {
    let state_dir = state_dir.display().to_string();
    RelaySettings::from_lookup(|name| match name {
        "WILDFLOWER_RELAY_DOMAIN" => Some("relay.example.com".to_owned()),
        "WILDFLOWER_RELAY_NOISE_PRIVATE_KEY" => Some(NOISE_PRIVATE_KEY.to_owned()),
        "WILDFLOWER_RELAY_STATE_DIR" => Some(state_dir.clone()),
        "WILDFLOWER_RELAY_ADMIN_KEY" => admin_key.map(str::to_owned),
        _ => None,
    })
    .expect("test settings")
}

/// What a test registry keeps alive: its state directory, and the feed of
/// what it serves to rathole, which no rathole server reads.
pub(crate) struct Fixture {
    _dir: tempfile::TempDir,
    pub(crate) rathole: RatholeFeed,
}

/// A registry over a fresh state directory.
pub(crate) async fn registry(admin_key: Option<&str>) -> (Arc<TunnelRegistry>, Fixture) {
    let dir = tempfile::tempdir().expect("tempdir");
    let (registry, rathole) = open_registry(&settings(dir.path(), admin_key)).await;
    (registry, Fixture { _dir: dir, rathole })
}

/// The registry the relay builds at startup from `settings`, and its feed.
pub(crate) async fn open_registry(settings: &RelaySettings) -> (Arc<TunnelRegistry>, RatholeFeed) {
    let (registry, rathole) = TunnelRegistry::open(settings).await.expect("registry");
    (Arc::new(registry), rathole)
}

/// The capability binding `F` over `registry`, as `Admin<F>` builds it for
/// an admin-signed request.
pub(crate) fn admin<F: AdminCapability<State = Arc<TunnelRegistry>>>(
    registry: &Arc<TunnelRegistry>,
) -> F {
    F::build(Arc::clone(registry))
}

/// Run a rathole client for the tunnel `name` with `token`, as a device
/// does with what `GET /rathole` serves for `settings`, until `shutdown_rx`
/// fires. The tunnel's visitors come out of the returned queue.
pub(crate) async fn device(
    settings: &RelaySettings,
    name: &str,
    token: &str,
    shutdown_rx: broadcast::Receiver<bool>,
) -> mpsc::Receiver<Box<dyn AsyncStream>> {
    let public = settings.public_rathole_settings();
    // The client runs with a visitor queue, so `local_addr` is never used.
    let config = format!(
        "[client]\nremote_addr = \"127.0.0.1:{port}\"\n\
         [client.transport]\ntype = \"noise\"\n\
         [client.transport.noise]\nremote_public_key = \"{key}\"\n\
         [client.services.{name}]\nlocal_addr = \"\"\ntoken = \"{token}\"\n",
        port = settings.control.control_addr.port(),
        key = public.public_key,
    );
    let (_, update_rx) = mpsc::channel(1);
    let (event_tx, mut events) = mpsc::unbounded_channel();
    tokio::spawn(rathole::run_client_with_visitor_queue(
        config.parse().expect("client config"),
        shutdown_rx,
        update_rx,
        event_tx,
    ));
    // The client reports its one service as soon as it starts it.
    let Some(ClientServiceEvent::TcpStarted {
        visitor_stream_rx, ..
    }) = events.recv().await
    else {
        panic!("the client starts the tunnel's service");
    };
    visitor_stream_rx
}

/// Wait until the device behind `device_visitors` takes the tunnel `name`'s
/// visitors, putting probe visitors through until one comes out.
pub(crate) async fn until_connected(
    tunnels: &Tunnels,
    name: &str,
    device_visitors: &mut mpsc::Receiver<Box<dyn AsyncStream>>,
) {
    let connected = async {
        loop {
            let (_probe, visitor) = tokio::io::duplex(64);
            if tunnels.connect(name, visitor).await.is_ok() {
                return device_visitors.recv().await;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    };
    tokio::time::timeout(Duration::from_secs(10), connected)
        .await
        .expect("the device should connect")
        .expect("the device takes the probe visitor");
}
