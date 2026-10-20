//! Host/HTTP-seam **dependency-inversion** traits the authorization server's
//! domain capabilities call out through — so `domain::capabilities` can
//! trigger the runtime side-effects a consent or logout flow needs without the
//! domain learning axum, the newest pending consent's watch channel, or the
//! revocation store's concrete type. The real implementations live in
//! `crate::adapters`, on
//! [`AuthorizationServerState`](crate::http::AuthorizationServerState); tests
//! wire in-memory fakes. Mirrors `apps-rust`'s `ports/`.
//!
//!  - [`OwnerApproval`] — ask the Owner: republish the newest pending consent
//!    to the host after any transition that may change it (see the trait);
//!  - [`Revocation`] / [`RevocationCheck`] — denylist a token `jti` or
//!    bulk-revoke a subject, and answer whether a token is revoked; the seams
//!    the revoking capabilities, logout, and the token verifier go through;
//!  - [`AuthorizationStartGate`] — the host's say over whether a request may
//!    start an authorization request, which the limit on `/oauth/authorize`
//!    and `/oauth/device_authorization` asks. Public: the host implements it.

mod authorization_start_gate;
mod owner_approval;
mod revocation;

pub use authorization_start_gate::{AdmitEveryAuthorizationStart, AuthorizationStartGate};

pub(crate) use owner_approval::OwnerApproval;
pub(crate) use revocation::{Revocation, RevocationCheck};
