//! Host/HTTP-seam **dependency-inversion** traits the gatekeeper domain actions
//! call out through — so the store-and-HTTP-free
//! [`actions`](crate::domain::actions) can still trigger the runtime side-effects
//! a consent or logout flow needs without the domain learning axum, the bridge,
//! or the revocation store's concrete type. The HTTP layer's
//! [`GatekeeperState`](crate::http::GatekeeperState) wires the real implementations (see
//! `http::state`); tests wire in-memory fakes. Mirrors `apps-rust`'s `ports/`.
//!
//!  - [`DeviceUserCodePublisher`] — republish the active device-code consent head
//!    over the bridge after a consent transition (a device approve/deny);
//!  - [`SessionRevoker`] — denylist a logged-out session token's `jti`;
//!  - [`SessionCookies`] — clear the owner session cookies. Used by the logout
//!    *handler* rather than a domain action (clearing cookies is a response
//!    concern), but kept here so the cookie format stays behind one seam too.

mod device_user_code_publisher;
mod session_cookies;
mod session_revoker;

pub(crate) use device_user_code_publisher::DeviceUserCodePublisher;
pub(crate) use session_cookies::SessionCookies;
pub(crate) use session_revoker::SessionRevoker;
