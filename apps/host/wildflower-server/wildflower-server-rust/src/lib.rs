//! The Wildflower server: the API every slice mounts on, composed by
//! [`set_up`] and served by [`WildflowerServer::serve`] on its one listener,
//! the tunnel listener.
//!
//! [`set_up`] opens the host's databases, sets up each server slice
//! (the authorization server, FHIR R4, OHIF, request log, apps, databases), gates
//! them, and wraps the result for the **tunnel listener** in the CORS policy,
//! the forwarded-request report and the tunnel front, which holds each request
//! to the server's domain. Every request is served at the server's origin,
//! `https://<domain>`, which every reader takes from config. It starts the
//! tunnel, which hands each visitor's stream to the tunnel listener in
//! process, the device certificate, which the tunnel listener's TLS serves,
//! and the reachability monitor. The server binds no port: it is reached only
//! through its tunnel, at `https://<domain>`, so while the relay can't be
//! reached nothing can reach the server.
//! [`WildflowerServer::serve`] then serves the tunnel listener until its
//! shutdown token is cancelled; the tunnel and the certificate's ordering and renewal
//! run for as long as it serves, and the monitor until the server first
//! answers through its public origin.
//! [`WildflowerServer::consent_decider_for_host`] is how the host decides the
//! server's pending consents in-process.
//!
//! The crate has no `tauri` dependency. What the host derives at build time or
//! from its platform paths arrives in [`WildflowerServerConfig`];
//! the channels the host watches the server through arrive in
//! [`ServerObservers`], among them the [`ServerHealth`] the reachability
//! monitor reads from the server's own `/health` through its public origin,
//! the [`TunnelState`](wildflowerhealthio_tunnel::TunnelState) the tunnel
//! publishes as it dials the relay, and the [`CertificateState`] the run
//! publishes as its certificate is deployed, ordered and renewed. What a
//! server's certificate cache says, the state of any server without a run's
//! state, is read by [`cached_certificate_state`], and the certificates its
//! runs deployed by [`read_certificate_history`].
//!
//! Layered like the other Rust slices:
//!
//!  - `config` — the host's inputs above, at the crate root like
//!    `authorization-server-rust`'s `config`.
//!  - `domain` — [`ServerHealth`] and the reachability monitor that publishes
//!    it, through its `HealthProbe` port; [`CertificateAuthority`],
//!    [`CertificateState`] with what a run observed that it is derived from,
//!    and [`CertificateHistoryEntry`].
//!  - `adapters` — ports implemented here, where both sides are in reach:
//!    apps' `AppLaunchScopes` from the authorization server's OAuth clients, and the
//!    monitor's `HealthProbe` over `reqwest`; and the device certificate,
//!    rustls-acme's order and renewal of the tunnel listener's certificate
//!    as [`DeviceCertificateConfig`] says, which reports its state and
//!    records each new certificate in the server's certificate history.
//!  - `http` — the server's own middleware (CORS, the forwarded-request
//!    report, the tunnel front), the tunnel listener
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
pub use config::{DeviceCertificateConfig, ServerObservers, WildflowerServerConfig};
pub use domain::certificate_authority::CertificateAuthority;
pub use domain::certificate_history::CertificateHistoryEntry;
pub use domain::certificate_state::{
    CertificateOrderError, CertificateState, CertificateStatus, IssuedCertificate,
};
pub use domain::server_health::ServerHealth;
pub use live_bindings::{set_up, WildflowerServer};
