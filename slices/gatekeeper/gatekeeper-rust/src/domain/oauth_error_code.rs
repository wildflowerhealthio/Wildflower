//! The closed set of OAuth error codes the gatekeeper's error surfaces are
//! allowed to emit — RFC 6749 §5.2, plus the §4.1.2.1 authorization-endpoint
//! redirect codes (`access_denied`, `unsupported_response_type`) and the
//! RFC 8628 §3.5 device-flow polling codes. Modeled as an enum so a code can't
//! be typo'd into a spec-violating string at a construction site (a free-typed
//! `"invalid_grnat"` no longer compiles), and so the valid set is enforced at
//! every construction site and documented in one place.
//!
//! `AsRef<str>` (and the matching `Display`) returns the exact RFC wire value,
//! so variants drop straight into the `OAuthErrorCode`-taking constructors
//! (`OAuthError::new`, `OAuthErrorResponse::new`, `TokenError::bad_request`) and
//! the redirect builder (`build_client_error_redirect_url`). Still untyped: the
//! `authorize.rs` HTML local-error page, which renders its own markup rather
//! than emitting a wire code.

use strum::{AsRefStr, Display};

/// A code from the closed set of OAuth error codes the gatekeeper's JSON error
/// surface may emit. Its [`AsRef<str>`]/[`Display`] impls (derived by `strum`
/// from the `snake_case` variant names) yield the exact RFC wire value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, AsRefStr, Display)]
#[strum(serialize_all = "snake_case")]
pub(crate) enum OAuthErrorCode {
    /// RFC 6749 §5.2 — the request is missing a required parameter, malformed,
    /// or otherwise invalid.
    InvalidRequest,
    /// RFC 6749 §5.2 — client authentication failed.
    InvalidClient,
    /// RFC 6749 §5.2 — the provided grant (authorization code, refresh token, …)
    /// is invalid, expired, revoked, or does not match.
    InvalidGrant,
    /// RFC 6749 §5.2 — the authenticated client is not authorized to use this
    /// grant type.
    UnauthorizedClient,
    /// RFC 6749 §5.2 — the requested scope is invalid, unknown, or exceeds what
    /// the client may hold.
    InvalidScope,
    /// RFC 6749 §4.1.2.1 — the authorization server does not support obtaining an
    /// authorization code using this `response_type`. Surfaced on the
    /// authorization-endpoint redirect, never the JSON token surface.
    UnsupportedResponseType,
    /// RFC 6749 §5.2 — the server encountered an unexpected condition.
    ServerError,
    /// RFC 6749 §4.1.2.1 — the resource owner (or authorization server) denied
    /// the request.
    AccessDenied,
    /// RFC 8628 §3.5 — the device authorization is still pending the user's
    /// action; the client should keep polling.
    AuthorizationPending,
    /// RFC 8628 §3.5 — the client is polling faster than the permitted interval
    /// and must back off.
    SlowDown,
    /// RFC 8628 §3.5 — the `device_code` has expired and the device-flow
    /// authorization session is no longer valid.
    ExpiredToken,
}

#[cfg(test)]
mod tests {
    use super::OAuthErrorCode;

    /// Each variant's wire value must match its exact RFC string — this guards
    /// the `strum` `serialize_all` rule (and any variant rename) from silently
    /// changing what ships on the wire.
    #[test]
    fn as_ref_matches_rfc_wire_values() {
        assert_eq!(OAuthErrorCode::InvalidRequest.as_ref(), "invalid_request");
        assert_eq!(OAuthErrorCode::InvalidClient.as_ref(), "invalid_client");
        assert_eq!(OAuthErrorCode::InvalidGrant.as_ref(), "invalid_grant");
        assert_eq!(
            OAuthErrorCode::UnauthorizedClient.as_ref(),
            "unauthorized_client"
        );
        assert_eq!(OAuthErrorCode::InvalidScope.as_ref(), "invalid_scope");
        assert_eq!(
            OAuthErrorCode::UnsupportedResponseType.as_ref(),
            "unsupported_response_type"
        );
        assert_eq!(OAuthErrorCode::ServerError.as_ref(), "server_error");
        assert_eq!(OAuthErrorCode::AccessDenied.as_ref(), "access_denied");
        assert_eq!(
            OAuthErrorCode::AuthorizationPending.as_ref(),
            "authorization_pending"
        );
        assert_eq!(OAuthErrorCode::SlowDown.as_ref(), "slow_down");
        assert_eq!(OAuthErrorCode::ExpiredToken.as_ref(), "expired_token");
    }

    /// `Display` must match `AsRef<str>` byte-for-byte — both are `strum`-derived
    /// from the same rule, and callers use each interchangeably.
    #[test]
    fn display_matches_as_ref() {
        for code in [
            OAuthErrorCode::InvalidRequest,
            OAuthErrorCode::InvalidClient,
            OAuthErrorCode::InvalidGrant,
            OAuthErrorCode::UnauthorizedClient,
            OAuthErrorCode::InvalidScope,
            OAuthErrorCode::UnsupportedResponseType,
            OAuthErrorCode::ServerError,
            OAuthErrorCode::AccessDenied,
            OAuthErrorCode::AuthorizationPending,
            OAuthErrorCode::SlowDown,
            OAuthErrorCode::ExpiredToken,
        ] {
            assert_eq!(code.to_string(), code.as_ref());
        }
    }
}
