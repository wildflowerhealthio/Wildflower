//! [`OAuthErrorKind`] — why `/oauth/authorize` refused a request. RFC 6749
//! §4.1.2.1 allows redirecting an error only to a validated `redirect_uri`:
//! once the redirect is trusted, a refusal goes back to the client with
//! [`OAuthErrorKind::description`] as its `error_description`; before that
//! point, or for a redirect nobody has vouched for, it renders as a local page
//! with the same sentence as its body. The HTML rendering lives in
//! `http::errors`; this is the vocabulary.

/// Why `/oauth/authorize` refused a request: shown on the local page, or sent
/// back to a trusted redirect as the `error_description`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(test, derive(strum::EnumIter))]
pub enum OAuthErrorKind {
    /// The `redirect_uri` is not a well-formed URL.
    InvalidRedirectUri,
    /// The `redirect_uri` is not `http` or `https`.
    InvalidScheme,
    /// The client has been disabled.
    DisabledClient,
    /// The `redirect_uri` is not on a server-defined registration.
    RedirectUriNotAllowed,
    /// `response_type` is not `code`.
    UnsupportedResponseType,
    /// `code_challenge_method` is not `S256`.
    UnsupportedCodeChallengeMethod,
    /// `code_challenge` is not a well-formed S256 challenge.
    InvalidCodeChallenge,
    /// `launch` names no launch this client may see: never minted, pruned
    /// after expiring, or another app's, which reads exactly like one that
    /// doesn't exist.
    LaunchUnknown,
    /// `launch` names this client's launch, which was consumed already.
    LaunchAlreadyUsed,
    /// `launch` names this client's launch, which is past its expiry.
    LaunchExpired,
    /// `aud` does not name this server's origin, its FHIR base.
    InvalidAudience,
}

impl OAuthErrorKind {
    /// The sentence saying why: the local page's body, and the
    /// `error_description` when the refusal goes back to the client. Plain
    /// ASCII without `"` or `\`, as RFC 6749 §4.1.2.1 requires of an
    /// `error_description`.
    #[must_use]
    pub fn description(self) -> &'static str {
        match self {
            OAuthErrorKind::InvalidRedirectUri => {
                "The supplied redirect_uri is not a well-formed URL."
            }
            OAuthErrorKind::InvalidScheme => "The supplied redirect_uri must use http or https.",
            OAuthErrorKind::DisabledClient => "The supplied client_id has been disabled.",
            OAuthErrorKind::RedirectUriNotAllowed => {
                "The supplied redirect_uri is not registered for this client."
            }
            OAuthErrorKind::UnsupportedResponseType => {
                "The app asked for a kind of sign-in this server doesn't support."
            }
            OAuthErrorKind::UnsupportedCodeChallengeMethod => {
                "The app's sign-in request uses a security method this server doesn't support."
            }
            OAuthErrorKind::InvalidCodeChallenge => {
                "The app's sign-in request has a malformed security check."
            }
            OAuthErrorKind::LaunchUnknown => "This launch isn't recognized. Open the app again.",
            OAuthErrorKind::LaunchAlreadyUsed => {
                "This launch was already used. Open the app again."
            }
            OAuthErrorKind::LaunchExpired => "This launch has expired. Open the app again.",
            OAuthErrorKind::InvalidAudience => {
                "The app asked for a different server than this one."
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use strum::IntoEnumIterator as _;

    use super::*;
    use crate::domain::client_redirect::{
        BROWSER_SIGNED_OUT_DESCRIPTION, REQUEST_DECLINED_DESCRIPTION,
        SCOPES_NOT_REGISTERED_DESCRIPTION,
    };

    /// RFC 6749 §4.1.2.1: `error_description` is `%x20-21 / %x23-5B /
    /// %x5D-7E`, printable ASCII without `"` or `\`.
    fn is_error_description(text: &str) -> bool {
        !text.is_empty()
            && text
                .bytes()
                .all(|byte| matches!(byte, 0x20..=0x21 | 0x23..=0x5B | 0x5D..=0x7E))
    }

    /// Every reason `/oauth/authorize` sends or shows is a valid
    /// `error_description`.
    #[test]
    fn every_description_is_a_valid_error_description() {
        for kind in OAuthErrorKind::iter() {
            assert!(
                is_error_description(kind.description()),
                "{kind:?}: {:?}",
                kind.description()
            );
        }
        for description in [
            SCOPES_NOT_REGISTERED_DESCRIPTION,
            BROWSER_SIGNED_OUT_DESCRIPTION,
            REQUEST_DECLINED_DESCRIPTION,
        ] {
            assert!(is_error_description(description), "{description:?}");
        }
    }

    /// The check refuses the two characters RFC 6749 leaves out, and
    /// anything outside printable ASCII.
    #[test]
    fn a_quote_backslash_or_non_ascii_is_not_an_error_description() {
        for text in ["say \"hi\"", "a\\b", "caf\u{e9}", "tab\there", ""] {
            assert!(!is_error_description(text), "{text:?}");
        }
    }
}
