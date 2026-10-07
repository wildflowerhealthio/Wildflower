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

use crate::ServerHealth;

/// What the host hands [`set_up`](crate::set_up): the values it derives at
/// build time (`tauri-shared-config.json`), from its platform paths, or from
/// the server's record.
#[derive(Debug, Clone)]
pub struct WildflowerServerConfig {
    /// The loopback base URL the API binds and the server's own folder, which
    /// its databases live in.
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
    /// The relay connection the server's tunnel dials, from the server's
    /// record.
    pub relay_settings: tunnel_rust::RelaySettings,
    /// The bare public host the relay serves the server at: the server's
    /// domain, from its record. The server's public origin, which HFS's links,
    /// app launches and the reachability monitor's `/health` use.
    pub public_host: String,
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

/// The channels the host watches a running server through. The host owns the
/// senders, and decides how long each lives: one per server run, or one
/// shared by every run.
#[derive(Clone)]
pub struct ServerObservers {
    /// Whether the server's `/health` answers through its public origin, and
    /// with what, published by the reachability monitor until the first
    /// answer. `None` until its first probe; the monitor stops when the server
    /// stops serving, and publishes nothing after.
    pub server_health_sender: watch::Sender<Option<ServerHealth>>,
    /// Each request the trusted front relayed through the tunnel, reported by
    /// the outermost layer after its response is ready (see
    /// `forwarded_request_layer`). A full channel drops the report rather than
    /// delaying the response. The same layer sends each record to the
    /// request-log slice, over a channel the server wires itself.
    pub forwarded_request_sender: mpsc::Sender<ForwardedRequest>,
}
