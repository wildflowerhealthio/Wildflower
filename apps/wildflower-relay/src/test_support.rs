//! Fixtures shared across the relay's unit tests: the settings a test relay
//! runs with, and the [`TunnelRegistry`] it builds from them over a fresh
//! state directory.

use crate::settings::RelaySettings;
use crate::tunnel_registry::TunnelRegistry;

const NOISE_PRIVATE_KEY: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

/// Settings for `relay.example.com` with `tunnels` in the environment, the
/// given port base and admin key, keeping state in `state_dir`.
pub(crate) fn settings(
    state_dir: &std::path::Path,
    tunnels: &str,
    port_base: u16,
    admin_key: Option<&str>,
) -> RelaySettings {
    let state_dir = state_dir.display().to_string();
    let port_base = port_base.to_string();
    RelaySettings::from_lookup(|name| match name {
        "WILDFLOWER_RELAY_DOMAIN" => Some("relay.example.com".to_owned()),
        "WILDFLOWER_RELAY_NOISE_PRIVATE_KEY" => Some(NOISE_PRIVATE_KEY.to_owned()),
        "WILDFLOWER_RELAY_TUNNELS" => Some(tunnels.to_owned()),
        "WILDFLOWER_RELAY_TUNNEL_PORT_BASE" => Some(port_base.clone()),
        "WILDFLOWER_RELAY_STATE_DIR" => Some(state_dir.clone()),
        "WILDFLOWER_RELAY_ADMIN_KEY" => admin_key.map(str::to_owned),
        _ => None,
    })
    .expect("test settings")
}

/// A registry over a fresh state directory, kept alive by the returned guard,
/// writing its TOML to `relay.toml` there.
pub(crate) async fn registry(
    tunnels: &str,
    admin_key: Option<&str>,
) -> (TunnelRegistry, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("tempdir");
    (open_registry(&dir, tunnels, admin_key).await, dir)
}

/// The registry the relay builds at startup in `dir`.
pub(crate) async fn open_registry(
    dir: &tempfile::TempDir,
    tunnels: &str,
    admin_key: Option<&str>,
) -> TunnelRegistry {
    TunnelRegistry::open(
        dir.path().join("relay.toml"),
        &settings(dir.path(), tunnels, 5201, admin_key),
    )
    .await
    .expect("registry")
}
