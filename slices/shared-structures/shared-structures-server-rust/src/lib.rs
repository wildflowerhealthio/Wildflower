//! Server-side shared infrastructure — the running counterpart to the pure
//! shapes in `shared-structures-rust`.
//!
//! - [`StaticHostsService`] runs a set of tower services, each on its own
//!   dedicated loopback port, started and stopped at runtime.
//! - [`TunnelSubdomainReverseProxy`] wraps a fallback router and reverse-proxies
//!   inbound forwarded `<id>.<public_host>` requests to the matching host's
//!   loopback port (looked up in a shared [`ProxyTable`]); everything else runs
//!   the fallback. The forward is a real HTTP hop to `http://{loopback}:{port}`,
//!   the same listener a local launch reaches — so a host has exactly one
//!   listener regardless of who reaches it.
//!
//! ## Producer/consumer invariant
//!
//! The `<id>.<public_host>` shape this crate splits inbound hosts on is the
//! shared [`shared_structures_rust::subdomain_host`] definition. A launch
//! handler that redirects a forwarded caller emits `subdomain_url(id, host)`;
//! this crate routes inbound hosts via `try_split_subdomain`. They are a matched
//! pair — change the shape in the shared module and both move together. If they
//! ever diverged, forwarded launches would fall through to the fallback,
//! unreachable from a remote browser, with no error.
//!
//! [`TunnelService`]: shared_structures_rust::tunnel_service::TunnelService

mod error;
mod host_match;
mod params;
mod reverse_proxy;
mod static_hosts;

pub use error::ServerError;
pub use params::{LoopbackHostname, StaticHostJob};
pub use reverse_proxy::{ProxyTable, TunnelSubdomainReverseProxy};
pub use static_hosts::StaticHostsService;
