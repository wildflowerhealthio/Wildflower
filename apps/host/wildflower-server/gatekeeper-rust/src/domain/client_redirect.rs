//! Pure builders for the OAuth authorization-code **client callback URLs** — the
//! `redirect_uri` the user-agent is sent back to once the flow resolves, with the
//! success (`code` + `state`) or failure (`error` + `state`) query appended (RFC
//! 6749 §4.1.2 / §4.1.2.1).
//!
//! Pure `Url` string-building with no axum, store, or HTTP coupling, so both the
//! `/oauth` route surface and the Owner consent `action`
//! can hand back the *same* callback URL without either reaching into the other —
//! the consent action returns the URL it builds here, and the handler just renders
//! it.

use url::Url;

use crate::domain::oauth_error_code::OAuthErrorCode;

/// Build the URL that closes the authorization-code flow by redirecting the
/// user-agent back to the client's already-parsed `redirect_uri` with `code`
/// and `state` appended.
pub(crate) fn build_client_redirect_url(
    redirect_uri: &Url,
    code: &str,
    client_state: &str,
) -> String {
    let mut url = redirect_uri.clone();
    url.query_pairs_mut()
        .append_pair("code", code)
        .append_pair("state", client_state);
    url.to_string()
}

/// Build the URL that closes the authorization-code flow with a failure by
/// redirecting the user-agent back to the client's already-parsed
/// `redirect_uri` with `error` and `state` appended (RFC 6749 §4.1.2.1).
pub(crate) fn build_client_error_redirect_url(
    redirect_uri: &Url,
    error: OAuthErrorCode,
    client_state: &str,
) -> String {
    let mut url = redirect_uri.clone();
    url.query_pairs_mut()
        .append_pair("error", error.as_ref())
        .append_pair("state", client_state);
    url.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn success_redirect_appends_code_and_state() {
        let redirect = Url::parse("https://client.example/cb").unwrap();
        let url = build_client_redirect_url(&redirect, "the-code", "the-state");
        assert_eq!(
            url,
            "https://client.example/cb?code=the-code&state=the-state"
        );
    }

    #[test]
    fn success_redirect_preserves_existing_query() {
        let redirect = Url::parse("https://client.example/cb?keep=1").unwrap();
        let url = build_client_redirect_url(&redirect, "c", "s");
        assert_eq!(url, "https://client.example/cb?keep=1&code=c&state=s");
    }

    #[test]
    fn error_redirect_appends_error_and_state() {
        let redirect = Url::parse("https://client.example/cb").unwrap();
        let url =
            build_client_error_redirect_url(&redirect, OAuthErrorCode::AccessDenied, "the-state");
        assert_eq!(
            url,
            "https://client.example/cb?error=access_denied&state=the-state"
        );
    }
}
