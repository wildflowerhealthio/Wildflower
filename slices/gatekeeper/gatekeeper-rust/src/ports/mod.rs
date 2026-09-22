//! Host/HTTP-seam **dependency-inversion** traits the gatekeeper domain actions
//! call out through — so the store-and-HTTP-free
//! `actions` can still trigger the runtime side-effects
//! a consent or logout flow needs without the domain learning axum, the bridge,
//! or the revocation store's concrete type. The HTTP layer's
//! [`GatekeeperState`](crate::http::GatekeeperState) wires the real implementations (see
//! `http::state`); tests wire in-memory fakes. Mirrors `apps-rust`'s `ports/`.
//!
//!  - [`PendingConsentPublisher`] — republish the active pending-consent head
//!    over the bridge after any transition that may change it (an
//!    `/authorize` or `/device_authorization` insert, an approve/deny on
//!    either consent surface);
//!  - [`Revocation`] / [`RevocationCheck`] — denylist a token `jti` or
//!    bulk-revoke a subject, and answer whether a token is revoked; the seams
//!    the revoking capabilities, logout, and the token verifier go through;
//!  - [`SelfHostedRedirectResolver`] — resolve a `client_id` to a self-hosted
//!    app's `{port, subdomain}` so `/authorize` can expand an app-relative
//!    redirect entry against the request's provenance (the one seam gatekeeper
//!    exposes *publicly*, since the host implements it from the apps store).

mod pending_consent_publisher;
mod revocation;
mod self_hosted_redirects;

pub(crate) use pending_consent_publisher::PendingConsentPublisher;
pub(crate) use revocation::{Revocation, RevocationCheck};
// Public (not `pub(crate)`): the host implements this seam and names its types
// when wiring `GatekeeperState`, so they are re-exported from the crate root.
pub use self_hosted_redirects::{
    NoSelfHostedRedirects, SelfHostedRedirectResolver, SelfHostedRedirectTopology,
};
