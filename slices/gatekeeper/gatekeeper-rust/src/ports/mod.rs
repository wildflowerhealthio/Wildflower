//! Host/HTTP-seam **dependency-inversion** traits the gatekeeper domain actions
//! call out through — so the store-and-HTTP-free
//! `actions` can still trigger the runtime side-effects
//! a consent or logout flow needs without the domain learning axum, the bridge,
//! or the revocation store's concrete type. The HTTP layer's
//! [`GatekeeperState`](crate::http::GatekeeperState) wires the real implementations (see
//! `http::state`); tests wire in-memory fakes. Mirrors `apps-rust`'s `ports/`.
//!
//!  - [`DeviceUserCodePublisher`] — republish the active device-code consent head
//!    over the bridge after a consent transition (a device approve/deny);
//!  - [`Revocation`] — denylist a token `jti` or bulk-revoke a subject; the seam
//!    the `GrantsRevoker`/`TokenRevoker` capabilities and logout revoke through;
//!  - [`SessionCookies`] — clear the owner session cookies. Used by the logout
//!    *handler* rather than a domain action (clearing cookies is a response
//!    concern), but kept here so the cookie format stays behind one seam too;
//!  - [`SelfHostedRedirectResolver`] — resolve a `client_id` to a self-hosted
//!    app's `{port, subdomain}` so `/authorize` can expand an app-relative
//!    redirect entry against the request's provenance (the one seam gatekeeper
//!    exposes *publicly*, since the host implements it from the apps store).

mod device_user_code_publisher;
mod revocation;
mod self_hosted_redirects;
mod session_cookies;

pub(crate) use device_user_code_publisher::DeviceUserCodePublisher;
pub(crate) use revocation::Revocation;
// Public (not `pub(crate)`): the host implements this seam and names its types
// when wiring `GatekeeperState`, so they are re-exported from the crate root.
pub use self_hosted_redirects::{
    NoSelfHostedRedirects, SelfHostedRedirectResolver, SelfHostedRedirectTopology,
};
pub(crate) use session_cookies::SessionCookies;
