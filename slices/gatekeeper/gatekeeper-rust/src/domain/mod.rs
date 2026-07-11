//! The gatekeeper's domain vocabulary — pure types and business rules
//! shared by every other layer. Nothing in here knows about axum or SQL;
//! persistence mappings live in [`crate::db`], transport in
//! [`crate::http`].

pub mod authorization_code;
pub mod authorization_request;
pub mod client;
pub mod grant;
// The closed set of OAuth error codes (RFC 6749 §5.2 + the redirect/device
// codes) — a pure domain vocabulary lifted out of the OAuth route tree so the
// error model can name it without reaching into `http`.
pub mod oauth_error_code;
// URL/path builders for the gatekeeper's user-facing `/gatekeeper/*` webview
// pages — pure string builders (no axum/state), duplicated TS ⇄ Rust and
// drift-tested against `gatekeeper-core/src/page-paths.ts`.
pub mod page_paths;
pub mod refresh_token;
pub mod signing_key;
pub mod token;
