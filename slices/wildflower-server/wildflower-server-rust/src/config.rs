//! What the host hands [`set_up`](crate::set_up): its build-time and
//! platform-path values, its native adapters and bridge channels, and the
//! channels it watches the server through.

use std::path::PathBuf;
use std::sync::Arc;

use gatekeeper_rust::{LoopbackConsentPrompt, PendingConsentHead};
use shared_structures_rust::owner_ui::OwnerUiBase;
use shared_structures_rust::request_caller::ForwardedRequest;
use shared_structures_rust::{OnDeviceWebviewHandle, ServerRuntimeConfig};
use tokio::sync::{mpsc, watch};
use tunnel_rust::TunnelLiveness;

/// What the host hands [`set_up`](crate::set_up): the values it derives at
/// build time (`tauri-shared-config.json`, build-time env) or from its platform
/// paths.
#[derive(Debug, Clone)]
pub struct WildflowerServerConfig {
    /// The loopback base URL the API binds and the app-data dir the databases live
    /// under.
    pub runtime: ServerRuntimeConfig,
    /// The directory holding the FHIR R4 SearchParameter bundle HFS indexes from
    /// (see
    /// [`EmrConfig::search_parameter_data_dir`](emr_rust::EmrConfig::search_parameter_data_dir)).
    pub search_parameter_data_dir: PathBuf,
    /// The hosted owner UI every browser-facing link points at.
    pub owner_ui_base: OwnerUiBase,
    /// The scopes gatekeeper seeds the first-party client with and mints the host
    /// owner token under (see
    /// [`GatekeeperConfig::host_owner_scopes`](gatekeeper_rust::GatekeeperConfig::host_owner_scopes)).
    pub host_owner_scopes: Vec<String>,
    /// The host's first-party OAuth `client_id`.
    pub first_party_client_id: String,
    /// Tunnel connection defaults seeded into unconfigured settings at startup.
    pub tunnel_seed: tunnel_rust::SettingsSeed,
}

/// The host's side of [`set_up`](crate::set_up): its native adapters and the
/// channels the server publishes host→webview state on.
///
/// The senders are owned by the host, so their receivers (the host's bridge)
/// outlive any one server; cloning the ports for another run keeps the same
/// channels.
#[derive(Clone)]
pub struct HostPorts {
    /// The native Approve / Reject dialog gatekeeper raises when the hosted owner
    /// UI logs in over direct loopback.
    pub loopback_consent_prompt: Arc<dyn LoopbackConsentPrompt>,
    /// Opens a loopback app launch in an on-device native webview popup.
    pub on_device_webview_handle: Arc<dyn OnDeviceWebviewHandle>,
    /// The channel gatekeeper publishes each minted host owner token on. The
    /// loopback owner trust reads it, so a receiver must be alive when
    /// [`set_up`](crate::set_up) mints the first token.
    pub host_owner_token_sender: watch::Sender<Option<String>>,
    /// The channel gatekeeper publishes the active pending consent request on.
    pub active_pending_consent_sender: watch::Sender<Option<PendingConsentHead>>,
}

/// The channels the host watches a running server through. Like [`HostPorts`],
/// the senders are owned by the host and outlive any one server.
#[derive(Clone)]
pub struct ServerObservers {
    /// The tunnel's liveness, copied from the tunnel slice by a task on the
    /// server's runtime. `None` until the server publishes it; the copy stops
    /// when that runtime does, so the host resets it to `None` once a server
    /// is gone.
    pub tunnel_liveness_sender: watch::Sender<Option<TunnelLiveness>>,
    /// Each forwarded request, a tunnel request among them, reported by the
    /// forwarded-request layer after its response is ready (see
    /// `forwarded_request_layer`). A full channel drops the report rather than
    /// delaying the response. The same layer sends each record to the tunnel
    /// slice's request log, over a channel the server wires itself.
    pub forwarded_request_sender: mpsc::Sender<ForwardedRequest>,
}
