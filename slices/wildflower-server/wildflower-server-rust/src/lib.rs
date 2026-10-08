//! The Wildflower server: the API every slice mounts on, composed by
//! [`set_up`] and served by [`WildflowerServer::serve`] on two listeners.
//!
//! [`set_up`] opens the host's databases, sets up each server slice
//! (gatekeeper, FHIR R4, OHIF, collector, request log, apps, databases), gates
//! them, and wraps the result once per listener: for the **loopback listener**
//! in the loopback owner trust, the loopback-peer gate, the CORS policy and the
//! forwarded-request report; for the **tunnel listener** in the CORS policy,
//! the forwarded-request report and the tunnel front, which holds each request
//! to the server's domain and writes its `Forwarded` header. It starts the
//! tunnel, which hands each visitor's stream to the tunnel listener in
//! process, the device certificate, which the tunnel listener's TLS serves,
//! and the reachability monitor, and binds the loopback port.
//! [`WildflowerServer::serve`] then serves both listeners until its shutdown
//! token is cancelled; the tunnel and the certificate's ordering and renewal
//! run for as long as it serves, and the monitor until the server first
//! answers through its public origin.
//! [`WildflowerServer::consent_decider_for_host`] is how the host decides the
//! server's pending consents in-process.
//!
//! The crate has no `tauri` dependency. What the host derives at build time or
//! from its platform paths arrives in [`WildflowerServerConfig`]; the host's
//! native adapters and the channels its bridge reads arrive in [`HostPorts`];
//! the channels the host watches the server through arrive in
//! [`ServerObservers`], among them the [`ServerHealth`] the reachability
//! monitor reads from the server's own `/health` through its public origin,
//! and the [`CertificateState`] the run publishes as its certificate is
//! deployed, ordered and renewed. What a server's certificate cache says, the
//! state of any server without a run's state, is read by
//! [`cached_certificate_state`], and the certificates its runs deployed by
//! [`read_certificate_history`].
//!
//! Layered like the other Rust slices:
//!
//!  - `config` — the host's inputs above, at the crate root like
//!    `gatekeeper-rust`'s `config`.
//!  - `domain` — [`ServerHealth`] and the reachability monitor that publishes
//!    it, through its `HealthProbe` port; [`CertificateAuthority`],
//!    [`CertificateState`] with what a run observed that it is derived from,
//!    and [`CertificateHistoryEntry`].
//!  - `adapters` — ports implemented here, where both sides are in reach:
//!    apps' `AppLaunchScopes` from gatekeeper's OAuth clients, and the
//!    monitor's `HealthProbe` over `reqwest`; and the device certificate,
//!    rustls-acme's order and renewal of the tunnel listener's certificate
//!    as [`DeviceCertificateConfig`] says, which reports its state and
//!    records each new certificate in the server's certificate history.
//!  - `http` — the server's own middleware (CORS, the loopback owner trust,
//!    the forwarded-request report, the tunnel front), the tunnel listener
//!    with its PROXY header reader and its TLS, the `/health` checks and the
//!    unmatched-route `404`.
//!  - `live_bindings` — [`set_up`] and [`WildflowerServer`].

mod adapters;
mod config;
mod domain;
mod http;
mod live_bindings;

pub use adapters::acme_certificate::cached_certificate_state;
pub use adapters::certificate_history::read_certificate_history;
pub use config::{DeviceCertificateConfig, HostPorts, ServerObservers, WildflowerServerConfig};
pub use domain::certificate_authority::CertificateAuthority;
pub use domain::certificate_history::CertificateHistoryEntry;
pub use domain::certificate_state::{
    CertificateOrderError, CertificateState, CertificateStatus, IssuedCertificate,
};
pub use domain::server_health::ServerHealth;
pub use live_bindings::{set_up, WildflowerServer};
