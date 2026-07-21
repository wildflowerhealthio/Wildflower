//! [`SelfHostedRedirectResolver`] — the seam that tells `/authorize` how to
//! resolve a client's app-relative redirect entry (see
//! [`RegisteredRedirectUri::AppRelative`](crate::domain::client::RegisteredRedirectUri::AppRelative))
//! into a concrete origin.
//!
//! A self-hosted app is served from its own origin — `http://127.0.0.1:<port>/`
//! on the device, `https://<subdomain>.<public_host>/` through the tunnel — but
//! that topology lives in the apps slice, not gatekeeper. Rather than couple the
//! `clients` table to app rows, gatekeeper asks this seam, keyed by the request's
//! `client_id` (a self-hosted app's OAuth `client_id` equals its app id), for the
//! app's `{port, subdomain}`. The authorize handler combines that with the
//! request's served origin + provenance to build the one origin the relative
//! entry resolves to (see `validate_redirect_url`).
//!
//! The host wires the real implementation (backed by the apps store) when it
//! builds [`GatekeeperState`](crate::live_bindings::GatekeeperState); a host with
//! no self-hosted apps (or a test) wires [`NoSelfHostedRedirects`], which
//! resolves nothing — every relative entry then matches no request, exactly as
//! if the feature were off.

/// A self-hosted app's redirect topology: the two facts needed to rebuild its
/// own origin from the request's served origin — the loopback `port` (for an
/// on-device launch) and the `subdomain` label (for a tunneled one).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelfHostedRedirectTopology {
    /// The loopback TCP port the app is served on (`http://127.0.0.1:<port>/`).
    pub port: u16,
    /// The public subdomain label the app is reachable at remotely
    /// (`https://<subdomain>.<public_host>/`).
    pub subdomain: String,
}

/// Resolves a `client_id` to the self-hosted app's redirect topology, or `None`
/// when the client isn't a self-hosted app (so it has no app-relative origin and
/// any relative allowlist entry it carries matches nothing).
pub trait SelfHostedRedirectResolver: Send + Sync {
    /// The topology for `client_id`, or `None` for a non-self-hosted (or unknown)
    /// client. A lookup failure resolves to `None` — a relative entry then
    /// matches no request, which is the safe (fail-closed) outcome.
    fn resolve(&self, client_id: &str) -> Option<SelfHostedRedirectTopology>;
}

/// A [`SelfHostedRedirectResolver`] that resolves nothing — for a host with no
/// self-hosted apps and the default in tests. A legitimate production posture
/// (an app-relative entry simply never matches), so it is a plain impl.
#[derive(Debug, Clone, Copy)]
pub struct NoSelfHostedRedirects;

impl SelfHostedRedirectResolver for NoSelfHostedRedirects {
    fn resolve(&self, _client_id: &str) -> Option<SelfHostedRedirectTopology> {
        None
    }
}
