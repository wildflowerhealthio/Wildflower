//! The gatekeeper's domain vocabulary — pure types and business rules
//! shared by every other layer. Nothing in here knows about axum or SQL —
//! the [`GatekeeperStore`] port abstracts persistence ([`crate::db`]'s
//! `SqliteGatekeeperStore` owns the SQL behind it), the [`actions`] over that
//! port hold the store-touching logic (the consent loaders and the `*NotFound`
//! semantic mapping), and everything fails with the domain's own [`error`]
//! vocabulary; persistence mappings live in [`crate::db`], transport in
//! [`crate::http`].

// The persistence port + the semantic actions over it — the seam the HTTP
// layer calls instead of touching a concrete store. Mirrors collector's
// `remotes_store` + `actions`.
pub mod actions;
pub mod gatekeeper_store;

pub mod authorization_code;
pub mod authorization_request;
pub mod client;
// The domain's failure vocabulary (collector's `RemoteError` is the model):
// semantic client-facing variants plus the opaque `Infrastructure`.
pub mod error;
pub mod grant;
// The closed set of OAuth error codes (RFC 6749 §5.2 + the redirect/device
// codes) — a pure domain vocabulary lifted out of the OAuth route tree so the
// error model can name it without reaching into `http`.
pub mod oauth_error_code;
// A validated, ready-to-act authorization-code consent request — built only by
// `actions::load_pending_authorization_code_request` (parse-don't-validate).
pub mod pending_code_consent;
// URL/path builders for the gatekeeper's user-facing `/gatekeeper/*` webview
// pages — pure string builders (no axum/state), duplicated TS ⇄ Rust and
// drift-tested against `gatekeeper-core/src/page-paths.ts`.
pub mod page_paths;
pub mod refresh_token;
pub mod signing_key;
pub mod token;

pub use gatekeeper_store::GatekeeperStore;
pub use pending_code_consent::PendingCodeConsent;
