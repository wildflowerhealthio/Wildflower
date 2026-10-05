//! Fixtures shared across the relay's unit tests: the settings a test relay
//! runs with, the [`TunnelRegistry`] it builds from them over a fresh state
//! directory, and the capability bindings built from that registry.

use std::collections::BTreeMap;
use std::sync::Arc;

use crate::live_bindings::state::TunnelRegistry;
use crate::live_bindings::AdminCapability;
use crate::settings::RelaySettings;

const NOISE_PRIVATE_KEY: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

/// Settings for `relay.example.com` with the given port base and admin key,
/// keeping state in `state_dir`.
pub(crate) fn settings(
    state_dir: &std::path::Path,
    port_base: u16,
    admin_key: Option<&str>,
) -> RelaySettings {
    let state_dir = state_dir.display().to_string();
    let port_base = port_base.to_string();
    RelaySettings::from_lookup(|name| match name {
        "WILDFLOWER_RELAY_DOMAIN" => Some("relay.example.com".to_owned()),
        "WILDFLOWER_RELAY_NOISE_PRIVATE_KEY" => Some(NOISE_PRIVATE_KEY.to_owned()),
        "WILDFLOWER_RELAY_TUNNEL_PORT_BASE" => Some(port_base.clone()),
        "WILDFLOWER_RELAY_STATE_DIR" => Some(state_dir.clone()),
        "WILDFLOWER_RELAY_ADMIN_KEY" => admin_key.map(str::to_owned),
        _ => None,
    })
    .expect("test settings")
}

/// A registry over a fresh state directory, kept alive by the returned guard,
/// writing its TOML to `relay.toml` there.
pub(crate) async fn registry(admin_key: Option<&str>) -> (Arc<TunnelRegistry>, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("tempdir");
    (open_registry(&dir, admin_key).await, dir)
}

/// The registry the relay builds at startup in `dir`, port base 5201.
pub(crate) async fn open_registry(
    dir: &tempfile::TempDir,
    admin_key: Option<&str>,
) -> Arc<TunnelRegistry> {
    let registry = TunnelRegistry::open(
        dir.path().join("relay.toml"),
        &settings(dir.path(), 5201, admin_key),
    )
    .await
    .expect("registry");
    Arc::new(registry)
}

/// The capability binding `F` over `registry`, as `Admin<F>` builds it for
/// an admin-signed request.
pub(crate) fn admin<F: AdminCapability<State = Arc<TunnelRegistry>>>(
    registry: &Arc<TunnelRegistry>,
) -> F {
    F::build(Arc::clone(registry))
}

/// Each service in the rathole config a registry in `dir` last wrote, as
/// rathole parses it: name → (bind address, token).
pub(crate) async fn rathole_services(
    dir: &tempfile::TempDir,
) -> BTreeMap<String, (String, Option<String>)> {
    rathole::Config::from_file(&dir.path().join("relay.toml"))
        .await
        .expect("rathole parses the rendered config")
        .server
        .expect("[server]")
        .services
        .into_iter()
        .map(|(name, service)| {
            (
                name,
                (service.bind_addr, service.token.map(|t| t.to_string())),
            )
        })
        .collect()
}
