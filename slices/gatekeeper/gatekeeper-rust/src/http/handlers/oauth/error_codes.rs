//! The closed set of OAuth error codes the gatekeeper's JSON error surface is
//! allowed to emit — RFC 6749 §5.2, plus §4.1.2.1 `access_denied` and the
//! RFC 8628 §3.5 device-flow polling codes. Modeled as an enum so a code can't
//! be typo'd into a spec-violating string at a construction site (a free-typed
//! `"invalid_grnat"` no longer compiles), and so the valid set is enforced at
//! every construction site and documented in one place.
//!
//! [`OAuthErrorCode::as_str`] returns the exact RFC wire value, so variants drop
//! straight into the `OAuthErrorCode`-taking constructors (`OAuthError::new`,
//! `OAuthErrorResponse::new`, `TokenError::bad_request`). Out of scope: the
//! `authorize.rs` HTML/redirect error surface, which renders its own pages.

use std::fmt;

/// A code from the closed set of OAuth error codes the gatekeeper's JSON error
/// surface may emit. [`as_str`](Self::as_str) yields the exact wire value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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

impl OAuthErrorCode {
    /// The exact RFC wire value for this code — the string that lands in the
    /// `error` field of an OAuth error body. `const` so it stays usable in
    /// const contexts.
    pub(crate) const fn as_str(&self) -> &'static str {
        match self {
            Self::InvalidRequest => "invalid_request",
            Self::InvalidClient => "invalid_client",
            Self::InvalidGrant => "invalid_grant",
            Self::UnauthorizedClient => "unauthorized_client",
            Self::InvalidScope => "invalid_scope",
            Self::ServerError => "server_error",
            Self::AccessDenied => "access_denied",
            Self::AuthorizationPending => "authorization_pending",
            Self::SlowDown => "slow_down",
            Self::ExpiredToken => "expired_token",
        }
    }
}

impl fmt::Display for OAuthErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::OAuthErrorCode;

    /// Each variant's wire value must match its exact RFC string — this guards
    /// the variant rename from silently changing what ships on the wire.
    #[test]
    fn as_str_matches_rfc_wire_values() {
        assert_eq!(OAuthErrorCode::InvalidRequest.as_str(), "invalid_request");
        assert_eq!(OAuthErrorCode::InvalidClient.as_str(), "invalid_client");
        assert_eq!(OAuthErrorCode::InvalidGrant.as_str(), "invalid_grant");
        assert_eq!(
            OAuthErrorCode::UnauthorizedClient.as_str(),
            "unauthorized_client"
        );
        assert_eq!(OAuthErrorCode::InvalidScope.as_str(), "invalid_scope");
        assert_eq!(OAuthErrorCode::ServerError.as_str(), "server_error");
        assert_eq!(OAuthErrorCode::AccessDenied.as_str(), "access_denied");
        assert_eq!(
            OAuthErrorCode::AuthorizationPending.as_str(),
            "authorization_pending"
        );
        assert_eq!(OAuthErrorCode::SlowDown.as_str(), "slow_down");
        assert_eq!(OAuthErrorCode::ExpiredToken.as_str(), "expired_token");
    }

    /// `Display` must delegate to `as_str()` byte-for-byte.
    #[test]
    fn display_delegates_to_as_str() {
        for code in [
            OAuthErrorCode::InvalidRequest,
            OAuthErrorCode::InvalidClient,
            OAuthErrorCode::InvalidGrant,
            OAuthErrorCode::UnauthorizedClient,
            OAuthErrorCode::InvalidScope,
            OAuthErrorCode::ServerError,
            OAuthErrorCode::AccessDenied,
            OAuthErrorCode::AuthorizationPending,
            OAuthErrorCode::SlowDown,
            OAuthErrorCode::ExpiredToken,
        ] {
            assert_eq!(code.to_string(), code.as_str());
        }
    }
}
