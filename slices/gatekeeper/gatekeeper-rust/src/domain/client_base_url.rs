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

    /// The normalized base, as the string a URL carries it in.
    #[must_use]
    pub fn as_str(&self) -> &str {
        self.0.as_url().as_str()
    }

    /// Whether `url` lies under this base: the same origin, and a path at or
    /// below the base's. The base's path always ends in `/`, so
    /// `…/staging/pr-73/` does not cover `…/staging/pr-736/`.
    #[must_use]
    pub fn covers(&self, url: &Url) -> bool {
        let base = self.0.as_url();
        url.origin() == base.origin() && url.path().starts_with(base.path())
    }
}

/// Where a first-party client's sign-in pages (the `/authorize` polling page,
/// the device-flow verification URIs) resolve — see
/// [`sign_in_owner_ui_for_client`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SignInOwnerUi {
    /// The pages resolve on this owner UI.
    Direct(OwnerUiBase),
    /// The pages resolve on `configured`, which asks the Owner before
    /// continuing on `claimed`: a first-party client named a copy that none of
    /// its registered redirects lies under.
    ConfirmFirst {
        configured: OwnerUiBase,
        claimed: ClientBaseUrl,
    },
}

/// Whether `client_id` is first-party: the hosted owner UI
/// (`wildflower-react`) or the host's `first_party_client_id`.
fn is_first_party(first_party_client_id: &str, client_id: &str) -> bool {
    client_id == HOSTED_OWNER_UI_CLIENT_ID || client_id == first_party_client_id
}

/// The owner UI the pages for `client_id` resolve on: the client's own
/// `claimed` base when `client_id` is first-party, otherwise the `configured`
/// one. For logout, whose caller is already authenticated; the sign-in pages
/// go through [`sign_in_owner_ui_for_client`] instead.
#[must_use]
pub fn owner_ui_for_client(
    configured: &OwnerUiBase,
    first_party_client_id: &str,
    client_id: &str,
    claimed: Option<ClientBaseUrl>,
) -> OwnerUiBase {
    match claimed {
        Some(ClientBaseUrl(base)) if is_first_party(first_party_client_id, client_id) => base,
        _ => configured.clone(),
    }
}

/// Where `client_id`'s sign-in pages resolve. The request naming the base is
/// unauthenticated, so a first-party `client_id` alone doesn't vouch for it:
/// the `claimed` base is used directly only when it is the `configured` one or
/// one of the client's `registered_redirect_uris` (resolved for this request)
/// lies under it — a redirect the Owner approved on an earlier sign-in.
/// Otherwise the pages stay on `configured`, which asks the Owner first. A
/// third-party client's base is ignored.
#[must_use]
pub fn sign_in_owner_ui_for_client(
    configured: &OwnerUiBase,
    first_party_client_id: &str,
    client_id: &str,
    claimed: Option<ClientBaseUrl>,
    registered_redirect_uris: &[Url],
) -> SignInOwnerUi {
    match claimed {
        Some(claimed) if is_first_party(first_party_client_id, client_id) => {
            let vouched = claimed.0 == *configured
                || registered_redirect_uris
                    .iter()
                    .any(|redirect_uri| claimed.covers(redirect_uri));
            if vouched {
                SignInOwnerUi::Direct(claimed.0)
            } else {
                SignInOwnerUi::ConfirmFirst {
                    configured: configured.clone(),
                    claimed,
                }
            }
        }
        _ => SignInOwnerUi::Direct(configured.clone()),
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

    fn url(raw: &str) -> Url {
        Url::parse(raw).expect("valid url")
    }

    fn staging() -> ClientBaseUrl {
        ClientBaseUrl::parse(STAGING).expect("valid client base")
    }

    #[test]
    fn covers_urls_on_its_origin_at_or_below_its_path() {
        assert!(staging().covers(&url(STAGING)));
        assert!(staging().covers(&url(&format!("{STAGING}signed-in?x=1"))));
        for outside in [
            "https://wildflowerhealthio.github.io/staging/pr-736/",
            "https://wildflowerhealthio.github.io/staging/pr-736/application",
            "https://wildflowerhealthio.github.io/staging/pr-7360/app/signed-in",
            "http://wildflowerhealthio.github.io/staging/pr-736/app/signed-in",
            "https://wildflowerhealthio.github.io:8443/staging/pr-736/app/signed-in",
            "https://evil.example/staging/pr-736/app/signed-in",
        ] {
            assert!(!staging().covers(&url(outside)), "{outside}");
        }
    }

    #[test]
    fn a_sign_in_base_a_registered_redirect_lies_under_is_used_directly() {
        for client_id in [HOSTED_OWNER_UI_CLIENT_ID, FIRST_PARTY] {
            let chosen = sign_in_owner_ui_for_client(
                &configured(),
                FIRST_PARTY,
                client_id,
                claimed(STAGING),
                &[url(&format!("{STAGING}signed-in"))],
            );
            assert_eq!(chosen, SignInOwnerUi::Direct(staging().0), "{client_id}");
        }
    }

    #[test]
    fn a_sign_in_base_no_registered_redirect_lies_under_asks_first() {
        let chosen = sign_in_owner_ui_for_client(
            &configured(),
            FIRST_PARTY,
            HOSTED_OWNER_UI_CLIENT_ID,
            claimed(STAGING),
            &[url(
                "https://wildflowerhealthio.github.io/staging/pr-735/app/signed-in",
            )],
        );
        assert_eq!(
            chosen,
            SignInOwnerUi::ConfirmFirst {
                configured: configured(),
                claimed: staging(),
            }
        );
    }

    #[test]
    fn naming_the_configured_base_needs_no_vouching() {
        let chosen = sign_in_owner_ui_for_client(
            &configured(),
            FIRST_PARTY,
            HOSTED_OWNER_UI_CLIENT_ID,
            claimed(CONFIGURED),
            &[],
        );
        assert_eq!(chosen, SignInOwnerUi::Direct(configured()));
    }

    #[test]
    fn a_sign_in_naming_no_base_gets_the_configured_one() {
        let chosen = sign_in_owner_ui_for_client(
            &configured(),
            FIRST_PARTY,
            HOSTED_OWNER_UI_CLIENT_ID,
            None,
            &[url(&format!("{STAGING}signed-in"))],
        );
        assert_eq!(chosen, SignInOwnerUi::Direct(configured()));
    }

    /// A claimed `https://{host}{path}` base, with the path's trailing slash
    /// optional.
    fn claimed_base() -> impl Strategy<Value = String> {
        ("[a-z]{1,12}\\.[a-z]{2,6}", "(/[a-z0-9-]{1,8}){0,3}/?")
            .prop_map(|(host, path)| format!("https://{host}{path}"))
    }

    proptest! {
        /// A third-party client can never move the owner UI, whatever base it
        /// names — the polling page is where its consent is decided.
        #[test]
        fn third_party_clients_always_get_the_configured_base(
            client_id in "[a-zA-Z0-9_-]{1,32}",
            base in claimed_base(),
        ) {
            prop_assume!(client_id != HOSTED_OWNER_UI_CLIENT_ID && client_id != FIRST_PARTY);
            let chosen = owner_ui_for_client(&configured(), FIRST_PARTY, &client_id, claimed(&base));
            prop_assert_eq!(chosen, configured());
            let chosen = sign_in_owner_ui_for_client(
                &configured(),
                FIRST_PARTY,
                &client_id,
                claimed(&base),
                &[url(&base)],
            );
            prop_assert_eq!(chosen, SignInOwnerUi::Direct(configured()));
        }

        /// A sign-in lands directly on a claimed base only when the configured
        /// base is that base, or a registered redirect lies under it — so a
        /// crafted link naming a first-party `client_id` can't move the pages
        /// anywhere the Owner hasn't already approved a redirect.
        #[test]
        fn a_sign_in_lands_directly_only_on_a_vouched_base(
            client_id in prop_oneof![Just(HOSTED_OWNER_UI_CLIENT_ID), Just(FIRST_PARTY)],
            base in claimed_base(),
            redirects in proptest::collection::vec(claimed_base(), 0..4),
            callback_under_base in any::<bool>(),
        ) {
            let claimed_base = ClientBaseUrl::parse(&base).expect("valid client base");
            let mut redirects: Vec<Url> = redirects.iter().map(|raw| url(raw)).collect();
            // Random hosts rarely collide, so plant the vouching redirect half
            // the time.
            if callback_under_base {
                redirects.push(url(&format!("{}signed-in", claimed_base.as_str())));
            }
            let vouched = claimed_base.0 == configured()
                || redirects.iter().any(|redirect| claimed_base.covers(redirect));
            let chosen = sign_in_owner_ui_for_client(
                &configured(),
                FIRST_PARTY,
                client_id,
                Some(claimed_base.clone()),
                &redirects,
            );
            let expected = if vouched {
                SignInOwnerUi::Direct(claimed_base.0)
            } else {
                SignInOwnerUi::ConfirmFirst { configured: configured(), claimed: claimed_base }
            };
            prop_assert_eq!(chosen, expected);
        }
    }
}
