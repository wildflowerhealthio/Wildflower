//! What the host hands [`set_up`](crate::set_up): its build-time and
//! platform-path values and the channels it watches the server through.

use std::path::PathBuf;

use tokio::sync::watch;
use url::Url;
use wildflowerhealthio_authorization_server::OwnerPrompt;
use wildflowerhealthio_shared_structures::authorization_app::AuthorizationAppBase;
use wildflowerhealthio_shared_structures::launcher::LauncherBase;
use wildflowerhealthio_shared_structures::ServerRuntimeConfig;
use wildflowerhealthio_tunnel::TunnelState;

use crate::{CertificateAuthority, CertificateState, ServerHealth};

/// What the host hands [`set_up`](crate::set_up): the values it derives at
/// build time (`tauri-shared-config.json`), from its platform paths, or from
/// the server's record.
#[derive(Debug, Clone)]
pub struct WildflowerServerConfig {
    /// The server's own folder, which its databases live in.
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
    /// The page the host opens the server's launches in, from its record:
    /// one `/oauth/sign-in` may send a browser on to (see
    /// [`AuthorizationServerConfig::launcher_url`](wildflowerhealthio_authorization_server::AuthorizationServerConfig::launcher_url)).
    pub launcher_url: Url,
    /// The page the host opens the server's Authorization app at, from its
    /// record: one `/oauth/sign-in` may send a browser on to (see
    /// [`AuthorizationServerConfig::authorization_url`](wildflowerhealthio_authorization_server::AuthorizationServerConfig::authorization_url)).
    pub authorization_url: Url,
    /// The scopes the authorization server seeds the host app's client with
    /// (see
    /// [`AuthorizationServerConfig::host_app_client_scopes`](wildflowerhealthio_authorization_server::AuthorizationServerConfig::host_app_client_scopes)).
    pub host_app_client_scopes: Vec<String>,
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

/// The channels the host watches a running server through. The host owns the
/// senders, one per server run.
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
    /// The server's newest pending consent, published by the authorization
    /// server as the run starts and after each change to its pending consents,
    /// for as long as the server runs.
    pub pending_consent_tx: watch::Sender<Option<OwnerPrompt>>,
}
