//! Which owner UI a first-party client's browser-facing pages resolve on: the
//! copy it names with [`CLIENT_BASE_URL_PARAM`], or the configured
//! [`OwnerUiBase`]. The concept is the "Client base URL" entry of
//! `slices/gatekeeper/docs/Jargon Explanation.md`.

use shared_structures_rust::owner_ui::OwnerUiBase;
use url::Url;

use crate::domain::capabilities::oauth::HOSTED_OWNER_UI_CLIENT_ID;

/// The query/form parameter a first-party client names its served root with —
/// `CLIENT_BASE_URL_PARAM` in `gatekeeper-core`'s `http-api-definition/oauth.ts`,
/// held equal to it by `gatekeeper-core/src/client-base-url-param.test.ts`, which
/// reads this file.
pub const CLIENT_BASE_URL_PARAM: &str = "wildflower_client_base_url";

/// A syntactically valid [`CLIENT_BASE_URL_PARAM`] value: an absolute `http` or
/// `https` URL, normalized to an [`OwnerUiBase`] (trailing slash, no query or
/// fragment). Valid is not trusted — whether it is used depends on the client
/// that sent it ([`owner_ui_for_client`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientBaseUrl(OwnerUiBase);

/// Why a [`CLIENT_BASE_URL_PARAM`] value was rejected.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ClientBaseUrlError {
    /// Not an absolute URL.
    #[error("{CLIENT_BASE_URL_PARAM} is not an absolute URL")]
    NotAbsolute,
    /// An absolute URL whose scheme is not `http` or `https` — a `javascript:`
    /// or `data:` value would otherwise land in a `Location` header.
    #[error("{CLIENT_BASE_URL_PARAM} must be an http or https URL")]
    NotHttp,
}

impl ClientBaseUrl {
    /// Validate a raw parameter value.
    ///
    /// # Errors
    ///
    /// [`ClientBaseUrlError::NotAbsolute`] when `raw` doesn't parse as an
    /// absolute URL, [`ClientBaseUrlError::NotHttp`] when its scheme is neither
    /// `http` nor `https`.
    pub fn parse(raw: &str) -> Result<Self, ClientBaseUrlError> {
        let url = Url::parse(raw).map_err(|_| ClientBaseUrlError::NotAbsolute)?;
        if !matches!(url.scheme(), "http" | "https") {
            return Err(ClientBaseUrlError::NotHttp);
        }
        OwnerUiBase::parse(url.as_str())
            .map(Self)
            .map_err(|_| ClientBaseUrlError::NotAbsolute)
    }

    /// Validate an optional parameter: absent stays `None`.
    ///
    /// # Errors
    ///
    /// As [`ClientBaseUrl::parse`], when `raw` is present.
    pub fn parse_optional(raw: Option<&str>) -> Result<Option<Self>, ClientBaseUrlError> {
        raw.map(Self::parse).transpose()
    }
}

/// The owner UI the pages for `client_id` resolve on: the client's own
/// `claimed` base when `client_id` is first-party — the hosted owner UI
/// (`wildflower-react`) or the host's `first_party_client_id` — otherwise the
/// `configured` one.
#[must_use]
pub fn owner_ui_for_client(
    configured: &OwnerUiBase,
    first_party_client_id: &str,
    client_id: &str,
    claimed: Option<ClientBaseUrl>,
) -> OwnerUiBase {
    let is_first_party =
        client_id == HOSTED_OWNER_UI_CLIENT_ID || client_id == first_party_client_id;
    match claimed {
        Some(ClientBaseUrl(base)) if is_first_party => base,
        _ => configured.clone(),
    }
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    use super::*;

    const CONFIGURED: &str = "https://wildflowerhealth.io/app/";
    const FIRST_PARTY: &str = "wildflower-host";
    const STAGING: &str = "https://wildflowerhealthio.github.io/staging/pr-736/app/";

    fn configured() -> OwnerUiBase {
        OwnerUiBase::parse(CONFIGURED).expect("valid base")
    }

    fn claimed(raw: &str) -> Option<ClientBaseUrl> {
        Some(ClientBaseUrl::parse(raw).expect("valid client base"))
    }

    #[test]
    fn parse_normalizes_to_a_slash_terminated_base_without_query_or_fragment() {
        let parsed =
            ClientBaseUrl::parse("https://wildflowerhealthio.github.io/staging/pr-736/app?x=1#y")
                .expect("valid");
        assert_eq!(parsed.0.as_url().as_str(), STAGING);
    }

    #[test]
    fn parse_rejects_relative_and_non_http_values() {
        assert_eq!(
            ClientBaseUrl::parse("/staging/app/"),
            Err(ClientBaseUrlError::NotAbsolute)
        );
        assert_eq!(
            ClientBaseUrl::parse(""),
            Err(ClientBaseUrlError::NotAbsolute)
        );
        for raw in [
            "javascript:alert(1)",
            "data:text/html,hi",
            "ftp://example.com/app/",
        ] {
            assert_eq!(
                ClientBaseUrl::parse(raw),
                Err(ClientBaseUrlError::NotHttp),
                "{raw}"
            );
        }
    }

    #[test]
    fn parse_optional_keeps_absent_absent() {
        assert_eq!(ClientBaseUrl::parse_optional(None), Ok(None));
        assert_eq!(
            ClientBaseUrl::parse_optional(Some("nope")),
            Err(ClientBaseUrlError::NotAbsolute)
        );
    }

    #[test]
    fn first_party_clients_resolve_on_the_base_they_name() {
        for client_id in [HOSTED_OWNER_UI_CLIENT_ID, FIRST_PARTY] {
            let chosen =
                owner_ui_for_client(&configured(), FIRST_PARTY, client_id, claimed(STAGING));
            assert_eq!(chosen.as_url().as_str(), STAGING, "{client_id}");
        }
    }

    #[test]
    fn a_first_party_client_naming_no_base_gets_the_configured_one() {
        let chosen =
            owner_ui_for_client(&configured(), FIRST_PARTY, HOSTED_OWNER_UI_CLIENT_ID, None);
        assert_eq!(chosen, configured());
    }

    proptest! {
        /// A third-party client can never move the owner UI, whatever base it
        /// names — the polling page is where its consent is decided.
        #[test]
        fn third_party_clients_always_get_the_configured_base(
            client_id in "[a-zA-Z0-9_-]{1,32}",
            host in "[a-z]{1,12}\\.[a-z]{2,6}",
            path in "(/[a-z0-9-]{1,8}){0,3}/?",
        ) {
            prop_assume!(client_id != HOSTED_OWNER_UI_CLIENT_ID && client_id != FIRST_PARTY);
            let chosen = owner_ui_for_client(
                &configured(),
                FIRST_PARTY,
                &client_id,
                claimed(&format!("https://{host}{path}")),
            );
            prop_assert_eq!(chosen, configured());
        }
    }
}
