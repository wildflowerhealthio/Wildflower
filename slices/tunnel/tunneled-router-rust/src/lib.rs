//! A general forwarded-subdomain router for the tunnel slice.
//!
//! Register a set of routers, each with a stable `id` and a dedicated loopback
//! `port` ([`TunneledRoute`]). [`TunneledRouterBuilder::build`] binds each one
//! on `{loopback_hostname}:{port}` (best-effort) and hands back a
//! [`SubdomainDispatch`] that [`wrap`](SubdomainDispatch::wrap)s an API router
//! with forwarded-subdomain dispatch:
//!
//! - **Loopback callers** reach each router directly on its own
//!   `http://{loopback}:{port}/` origin — its own security context.
//! - **Forwarded callers** (relayed through the tunnel) land on the main API
//!   port with no per-app socket. A request whose `Forwarded` host is exactly
//!   `<id>.<public_host>` (the live [`TunnelService::current_public_host`], port-
//!   and case-insensitive) is dispatched in software into that route's router;
//!   everything else falls through to the wrapped API.
//!
//! ## Producer/consumer invariant
//!
//! The `<id>.<public_host>` shape this crate matches is the shared
//! [`shared_structures_rust::subdomain_host`] definition. A launch handler that
//! redirects a forwarded caller emits `subdomain_host::subdomain_url(id, host)`;
//! this crate routes inbound hosts via `subdomain_host::match_subdomain`. They
//! are a matched pair — change the shape in one place (the shared module) and
//! both move together. If they ever diverged, forwarded launches would fall
//! through to the API, unreachable from a remote browser, with no error.
//!
//! [`TunnelService`]: shared_structures_rust::tunnel_service::TunnelService
//! [`TunnelService::current_public_host`]: shared_structures_rust::tunnel_service::TunnelService::current_public_host

mod binding;
mod builder;
mod dispatch;
mod host_match;

pub use builder::{SubdomainDispatch, TunneledRoute, TunneledRouterBuilder};
