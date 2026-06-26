//! Typed parameters for the server infra — a bare loopback hostname and a
//! single static-host job — so "host vs hostname vs origin" is unmistakable at
//! the call site.

/// A bare loopback hostname — no scheme, no port (e.g. `127.0.0.1`). Distinct
/// from a loopback *origin* (`http://127.0.0.1:8080`) and from a `host:port`
/// authority; the type never holds a port on its own. Combined with a per-job
/// `port` to form a bind address or a forward target via [`Self::authority`].
#[derive(Debug, Clone)]
pub struct LoopbackHostname(String);

impl LoopbackHostname {
    #[must_use]
    pub fn new(hostname: impl Into<String>) -> Self {
        Self(hostname.into())
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// `{hostname}:{port}` — the one place a port is joined onto the hostname
    /// (the listener bind address and the reverse-proxy forward target).
    #[must_use]
    pub(crate) fn authority(&self, port: u16) -> String {
        format!("{}:{}", self.0, port)
    }
}

/// One static host to serve on a dedicated loopback port: a stable `id` (also
/// the subdomain label and the proxy-table key), the `port` its listener binds,
/// and the `service` that answers its requests.
pub struct StaticHostJob<S> {
    pub id: String,
    pub port: u16,
    pub service: S,
}
