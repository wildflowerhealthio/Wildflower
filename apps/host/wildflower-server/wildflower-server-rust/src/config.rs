//! What the host hands [`set_up`](crate::set_up): its build-time and
//! platform-path values, its native adapters, and the channels it watches the
//! server through.

use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::{mpsc, watch};
use wildflowerhealthio_authorization_server::{LoopbackConsentPrompt, PendingConsentHead};
use wildflowerhealthio_shared_structures::authorization_app::AuthorizationAppBase;
use wildflowerhealthio_shared_structures::launcher::LauncherBase;
use wildflowerhealthio_shared_structures::request_caller::ForwardedRequest;
use wildflowerhealthio_shared_structures::ServerRuntimeConfig;
use wildflowerhealthio_tunnel::TunnelState;

use crate::{CertificateAuthority, CertificateState, ServerHealth};

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
    /// [`FhirR4Config::search_parameter_data_dir`](wildflowerhealthio_fhir_r4::FhirR4Config::search_parameter_data_dir)).
    pub search_parameter_data_dir: PathBuf,
    /// The hosted launcher every browser-facing link points at.
    pub launcher_base: LauncherBase,
    /// The hosted Wildflower Authorization app, which the server's SMART
    /// discovery advertises as its `management_endpoint`.
    pub authorization_app_base: AuthorizationAppBase,
    /// The scopes the authorization server seeds the host app's client with and mints the host
    /// owner token under (see
    /// [`AuthorizationServerConfig::host_owner_scopes`](wildflowerhealthio_authorization_server::AuthorizationServerConfig::host_owner_scopes)).
    pub host_owner_scopes: Vec<String>,
    /// The Wildflower host app's OAuth `client_id`.
    pub wildflower_host_app_client_id: String,
    /// The relay connection the server's tunnel dials, from the server's
    /// record.
    pub relay_settings: wildflowerhealthio_tunnel::RelaySettings,
    /// The server's domain, from its record: the bare host the relay serves
    /// the server at. The server's public origin, which HFS's links, app
    /// launches and the reachability monitor's `/health` use, and the one
    /// name on its certificate.
    pub domain: String,
    /// Where the server's certificate is ordered from and cached, from its
    /// record.
    pub device_certificate: DeviceCertificateConfig,
}

/// Where the server's certificate for its domain comes from: the ACME CA
/// it is ordered from, at the CA's own directory
/// ([`CertificateAuthority::directory_url`]), and the folders it and the
/// install's ACME account are cached in. The host builds it from the
/// server's record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceCertificateConfig {
    /// The ACME CA the server's certificate is ordered from, at its
    /// directory, as the server's record names it: the issuer its state and
    /// history report.
    pub certificate_authority: CertificateAuthority,
    /// The folder the server's certificates and their keys are cached in,
    /// its own: deleting the server deletes them.
    pub certificate_dir: PathBuf,
    /// The folder the install's ACME account keys are cached in, one per CA,
    /// shared by every server.
    pub acme_account_dir: PathBuf,
}

/// The host's side of [`set_up`](crate::set_up): its native adapters, which
/// every run of every server shares.
#[derive(Clone)]
pub struct HostPorts {
    /// The native Approve / Reject dialog the authorization server raises when the hosted owner
    /// UI logs in over direct loopback.
    pub loopback_consent_prompt: Arc<dyn LoopbackConsentPrompt>,
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
    pub server_health_tx: watch::Sender<Option<ServerHealth>>,
    /// Where the tunnel's connection to the relay stands, published by the
    /// tunnel daemon as the run starts and on each dial's outcome, for as long
    /// as the server serves. `None` until the run's tunnel starts; the daemon
    /// publishes nothing after it stops.
    pub tunnel_state_tx: watch::Sender<Option<TunnelState>>,
    /// Where the server's certificate stands, published by the run as it
    /// starts, on each of rustls-acme's events, and when the certificate's
    /// renewal falls due or it expires. `None` until the run's certificate
    /// starts; the run publishes nothing after it stops.
    pub certificate_tx: watch::Sender<Option<CertificateState>>,
    /// The head of the server's pending-consent queue, published by
    /// the authorization server as the run starts and after each change to the queue, for
    /// as long as the server runs.
    pub pending_consent_tx: watch::Sender<Option<PendingConsentHead>>,
    /// Each forwarded request (every request through the tunnel, and each one
    /// a front run on this machine relayed), reported by the forwarded-request
    /// layer after its response is ready (see `forwarded_request_layer`). A
    /// full channel drops the report rather than delaying the response. The
    /// same layer sends each record to the request-log slice, over a channel
    /// the server wires itself.
    pub forwarded_request_tx: mpsc::Sender<ForwardedRequest>,
}
