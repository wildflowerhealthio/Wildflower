//! Host/HTTP-seam **dependency-inversion** traits the authorization server domain actions
//! call out through — so the store-and-HTTP-free
//! `actions` can still trigger the runtime side-effects
//! a consent or logout flow needs without the domain learning axum, the newest
//! pending consent's watch channel, or the revocation store's concrete type. The HTTP layer's
//! [`AuthorizationServerState`](crate::http::AuthorizationServerState) wires the real implementations (see
//! `http::state`); tests wire in-memory fakes. Mirrors `apps-rust`'s `ports/`.
//!
//!  - [`OwnerApproval`] — ask the Owner: republish the newest pending consent
//!    to the host after any transition that may change it (an
//!    `/authorize` or `/device_authorization` insert, an approve/deny on
//!    either consent surface);
//!  - [`Revocation`] / [`RevocationCheck`] — denylist a token `jti` or
//!    bulk-revoke a subject, and answer whether a token is revoked; the seams
//!    the revoking capabilities, logout, and the token verifier go through.

mod owner_approval;
mod revocation;

pub(crate) use owner_approval::OwnerApproval;
pub(crate) use revocation::{Revocation, RevocationCheck};
