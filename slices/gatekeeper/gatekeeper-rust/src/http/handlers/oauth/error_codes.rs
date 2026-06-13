//! The closed set of OAuth error codes the gatekeeper's JSON error surface is
//! allowed to emit — RFC 6749 §5.2, plus §4.1.2.1 `access_denied` and the
//! RFC 8628 §3.5 device-flow polling codes. Centralized here so a code can't be
//! typo'd into a spec-violating string at a construction site (a free-typed
//! `"invalid_grnat"` compiles and ships), and so the valid set is documented in
//! one place.
//!
//! These are the wire values, so they drop straight into the existing
//! `&str`-taking constructors (`OAuthError::new`, `OAuthErrorResponse::new`,
//! `TokenError::bad_request`) with no signature changes. Out of scope: the
//! `authorize.rs` HTML/redirect error surface, which renders its own pages.

/// RFC 6749 §5.2 — the request is missing a required parameter, malformed, or
/// otherwise invalid.
pub(crate) const INVALID_REQUEST: &str = "invalid_request";
/// RFC 6749 §5.2 — client authentication failed.
pub(crate) const INVALID_CLIENT: &str = "invalid_client";
/// RFC 6749 §5.2 — the provided grant (authorization code, refresh token, …) is
/// invalid, expired, revoked, or does not match.
pub(crate) const INVALID_GRANT: &str = "invalid_grant";
/// RFC 6749 §5.2 — the authenticated client is not authorized to use this grant
/// type.
pub(crate) const UNAUTHORIZED_CLIENT: &str = "unauthorized_client";
/// RFC 6749 §5.2 — the requested scope is invalid, unknown, or exceeds what the
/// client may hold.
pub(crate) const INVALID_SCOPE: &str = "invalid_scope";
/// RFC 6749 §5.2 — the server encountered an unexpected condition.
pub(crate) const SERVER_ERROR: &str = "server_error";
/// RFC 6749 §4.1.2.1 — the resource owner (or authorization server) denied the
/// request.
pub(crate) const ACCESS_DENIED: &str = "access_denied";
/// RFC 8628 §3.5 — the device authorization is still pending the user's action;
/// the client should keep polling.
pub(crate) const AUTHORIZATION_PENDING: &str = "authorization_pending";
/// RFC 8628 §3.5 — the client is polling faster than the permitted interval and
/// must back off.
pub(crate) const SLOW_DOWN: &str = "slow_down";
/// RFC 8628 §3.5 — the `device_code` has expired and the device-flow
/// authorization session is no longer valid.
pub(crate) const EXPIRED_TOKEN: &str = "expired_token";
