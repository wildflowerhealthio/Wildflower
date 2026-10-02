//! Pure builders for the OAuth authorization-code **client callback URLs** — the
//! `redirect_uri` the user-agent is sent back to once the flow resolves, with the
//! success (`code` + `state`) or failure (`error` + `state`) query appended (RFC
//! 6749 §4.1.2 / §4.1.2.1) — plus the **allowlist check** that decides
//! whether a presented `redirect_uri` is one the client registered
//! ([`redirect_is_allowlisted`]).
//!
//! Pure `Url` string-building with no axum, store, or HTTP coupling, so both the
//! `/oauth` route surface and the Owner consent `action`
//! can hand back the *same* callback URL without either reaching into the other —
//! the consent action returns the URL it builds here, and the handler just renders
//! it. The allowlist check lives here for the same reason: `/authorize` and the
//! consent read path must reach the same verdict about the same URI, so they
//! share one implementation (see
//! [`client_registration`](crate::domain::client_registration)).

use url::Url;

use crate::domain::client::Client;
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

/// Whether `requested_redirect_uri` exactly equals an entry on
/// `existing_client`'s redirect allowlist. This is the one allowlist verdict:
/// both `/authorize` and the consent read path call it, so a prompt can never
/// disagree with the endpoint that parked it.
pub(crate) fn redirect_is_allowlisted(
    existing_client: &Client,
    requested_redirect_uri: &Url,
) -> bool {
    existing_client
        .redirect_uris
        .contains(requested_redirect_uri)
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
