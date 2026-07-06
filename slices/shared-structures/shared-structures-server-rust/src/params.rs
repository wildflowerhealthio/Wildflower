//! Typed parameters for the server infra — the loopback bind/forward authority
//! helper and a single static-host job — so "host vs hostname vs origin" is
//! unmistakable at the call site.

use url::Url;

/// The `{host}:{port}` authority a loopback listener binds on (or a reverse-proxy
/// forward targets), built from the host's loopback base `url` and a per-job
/// `port`. This is the one place a port is joined onto the loopback host, and the
/// only place the base URL is reduced to a string — right at the OS/reqwest
/// boundary. The base URL's *own* port is ignored; each static host carries its
/// own. Falls back to `127.0.0.1` only if the URL somehow carries no host (a
/// non-special scheme the loopback URL never uses), matching
/// `ServerRuntimeConfig`'s loopback derivation.
#[must_use]
pub(crate) fn loopback_authority(url: &Url, port: u16) -> String {
    format!("{}:{}", url.host_str().unwrap_or("127.0.0.1"), port)
}

/// One static host to serve on a dedicated loopback port: a stable `id` (also
/// the subdomain label and the proxy-table key), the `port` its listener binds,
/// and the `service` that answers its requests.
pub struct StaticHostJob<S> {
    pub id: String,
    pub port: u16,
    pub service: S,
}
