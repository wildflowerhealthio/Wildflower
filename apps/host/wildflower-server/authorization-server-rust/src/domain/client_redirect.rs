//! Pure builders for the OAuth authorization-code **client callback URLs** — the
//! `redirect_uri` the user-agent is sent back to once the flow resolves, with the
//! success (`code` + `state`) or failure (`error` + `error_description` +
//! `state`) query appended (RFC 6749 §4.1.2 / §4.1.2.1).
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

/// The `error_description` for a request, from a client with a fixed
/// (server-defined) registration, for scopes outside that registration
/// (`invalid_scope`).
pub(crate) const SCOPES_NOT_REGISTERED_DESCRIPTION: &str =
    "The app asked for access it isn't registered for.";

/// The `error_description` for a request whose browser session was revoked
/// before its code was issued (`access_denied`).
pub(crate) const BROWSER_SIGNED_OUT_DESCRIPTION: &str =
    "This browser was signed out before the sign-in finished.";

/// The `error_description` for a request the Owner declined (`access_denied`).
/// The status poll sends it for every denial, since it can't tell a decline
/// from a revoked browser session.
pub(crate) const REQUEST_DECLINED_DESCRIPTION: &str = "The request was declined.";

/// Build the URL that closes the authorization-code flow with a failure by
/// redirecting the user-agent back to the client's already-parsed
/// `redirect_uri` with `error`, `error_description` and `state` appended, in
/// that order (RFC 6749 §4.1.2.1). `description` is one of the fixed
/// sentences ([`AuthorizeRefusal::description`] or this module's consts), never
/// request input.
///
/// [`AuthorizeRefusal::description`]: crate::domain::authorize_refusal::AuthorizeRefusal::description
pub(crate) fn build_client_error_redirect_url(
    redirect_uri: &Url,
    error: OAuthErrorCode,
    description: &str,
    client_state: &str,
) -> String {
    let mut url = redirect_uri.clone();
    url.query_pairs_mut()
        .append_pair("error", error.as_ref())
        .append_pair("error_description", description)
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
    fn error_redirect_appends_error_description_and_state_in_order() {
        let redirect = Url::parse("https://client.example/cb").unwrap();
        let url = build_client_error_redirect_url(
            &redirect,
            OAuthErrorCode::AccessDenied,
            REQUEST_DECLINED_DESCRIPTION,
            "the-state",
        );
        assert_eq!(
            url,
            "https://client.example/cb?error=access_denied\
             &error_description=The+request+was+declined.&state=the-state"
        );
    }

    #[test]
    fn error_redirect_preserves_existing_query() {
        let redirect = Url::parse("https://client.example/cb?keep=1").unwrap();
        let url = build_client_error_redirect_url(
            &redirect,
            OAuthErrorCode::InvalidRequest,
            "This launch isn't recognized. Open the app again.",
            "s",
        );
        assert_eq!(
            url,
            "https://client.example/cb?keep=1&error=invalid_request\
             &error_description=This+launch+isn%27t+recognized.+Open+the+app+again.&state=s"
        );
    }
}
