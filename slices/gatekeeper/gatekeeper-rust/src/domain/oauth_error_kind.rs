//! [`OAuthErrorKind`] — the `/oauth/authorize` failures that may **not** be
//! redirected back to the client (RFC 6749 §4.1.2.1 restricts redirecting an
//! error to a validated `redirect_uri`; before that point, or for a redirect
//! nobody has vouched for, the failure renders as a local page). The HTML
//! rendering lives in `http::errors`; this is the vocabulary.

/// A `/oauth/authorize` failure rendered as a local HTML page.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OAuthErrorKind {
    /// The `redirect_uri` is not a well-formed URL.
    InvalidRedirectUri,
    /// The `redirect_uri` is not `http` or `https`.
    InvalidScheme,
    /// The first-party `client_id` has no registration.
    UnknownClient,
    /// The client has been disabled.
    DisabledClient,
    /// The first-party client's `redirect_uri` is not registered.
    RedirectUriNotAllowed,
    /// `response_type` is not `code`.
    UnsupportedResponseType,
    /// `code_challenge_method` is not `S256`.
    UnsupportedCodeChallengeMethod,
    /// `code_challenge` is not a well-formed S256 challenge.
    InvalidCodeChallenge,
    /// `wildflower_client_base_url` is present but not an absolute `http` or
    /// `https` URL (see [`crate::domain::client_base_url`]).
    InvalidClientBaseUrl,
}
