//! Where the hosted owner UI lives, and the URLs that send a browser there.
//!
//! The owner UI (`apps/wildflower-react`'s `main-web` build) is published at a
//! fixed address — `https://wildflowerhealth.io/app/` — and runs **cross-origin**
//! to whichever Wildflower server its `?server=` query parameter names. Apart
//! from the gatekeeper's `/authorize` wait page, a server serves no UI of its
//! own, so every other browser-facing page it hands out (the device-flow
//! `verification_uri`, logout's landing, the link on an unmatched route's `404`)
//! is a URL on that hosted UI carrying `server=<the request's served origin>`.
//!
//! [`OwnerUiBase`] is the one place those URLs are spelled. The host decides the
//! base (from `tauri-shared-config.json`, switching to the local `main-web` dev
//! server in debug builds) and threads it in; slices never name the address.

use url::Url;

/// The query parameter the owner UI reads its API server from —
/// `gatekeeper-core/smart-client`'s `SERVER_QUERY_PARAM`. Held equal to it by
/// `apps/wildflower-react/src/owner-ui-address.test.ts`, which reads this file.
const SERVER_PARAM: &str = "server";

/// The query parameter the owner UI's landing page returns the reader to after
/// sign-in — `RETURN_TO_PARAM` in `apps/wildflower-react/src/sign-in.ts`, held
/// equal to it by the same test.
const RETURN_TO_PARAM: &str = "returnTo";

/// The root URL of the hosted owner UI, e.g. `https://wildflowerhealth.io/app/`.
///
/// Always stored with a trailing slash, so an owner-UI route resolves *under*
/// the base (`…/app/` + `gatekeeper/devices`) rather than replacing its last
/// segment, which is what [`Url::join`] does to a base without one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnerUiBase(Url);

impl OwnerUiBase {
    /// Parse the owner-UI root, adding the trailing slash if it is missing.
    ///
    /// # Errors
    ///
    /// Returns the [`url::ParseError`] when `base` is not an absolute URL.
    pub fn parse(base: &str) -> Result<Self, url::ParseError> {
        let mut url = Url::parse(base)?;
        if !url.path().ends_with('/') {
            let path = format!("{}/", url.path());
            url.set_path(&path);
        }
        url.set_query(None);
        url.set_fragment(None);
        Ok(Self(url))
    }

    /// The owner-UI root itself.
    #[must_use]
    pub fn as_url(&self) -> &Url {
        &self.0
    }

    /// The owner-UI page at `route`, pointed at `server_origin`.
    ///
    /// `route` is an origin-relative owner-UI path (`/gatekeeper/devices`) whose
    /// segments are already percent-encoded; it is resolved under the base.
    /// `server` comes first in the query, then `extra_query` in order.
    #[must_use]
    pub fn route_url(&self, route: &str, server_origin: &str, extra_query: &[(&str, &str)]) -> Url {
        let relative = route.trim_start_matches('/');
        // Joining a relative path onto an absolute, slash-terminated base only
        // fails for input no `route` caller produces (a path that is itself a
        // scheme-looking string); fall back to the root rather than panic.
        let mut url = self.0.join(relative).unwrap_or_else(|_| self.0.clone());
        {
            let mut query = url.query_pairs_mut();
            query.append_pair(SERVER_PARAM, server_origin);
            for (key, value) in extra_query {
                query.append_pair(key, value);
            }
        }
        url
    }

    /// The owner-UI landing page, pointed at `server_origin`, that returns the
    /// reader to `return_to` (an origin-relative path, query included) once
    /// they have signed in — the link an unmatched host route offers.
    #[must_use]
    pub fn open_url(&self, server_origin: &str, return_to: &str) -> Url {
        self.route_url("/", server_origin, &[(RETURN_TO_PARAM, return_to)])
    }
}

#[cfg(test)]
mod tests {
    use super::OwnerUiBase;

    const SERVER: &str = "http://127.0.0.1:8080";

    fn base(raw: &str) -> OwnerUiBase {
        OwnerUiBase::parse(raw).expect("valid base")
    }

    #[test]
    fn parse_adds_the_trailing_slash_and_drops_query_and_fragment() {
        assert_eq!(
            base("https://wildflowerhealth.io/app?x=1#y")
                .as_url()
                .as_str(),
            "https://wildflowerhealth.io/app/"
        );
        assert_eq!(
            base("http://localhost:5195").as_url().as_str(),
            "http://localhost:5195/"
        );
    }

    #[test]
    fn parse_rejects_a_relative_base() {
        assert!(OwnerUiBase::parse("/app/").is_err());
    }

    #[test]
    fn route_url_resolves_under_the_base_with_server_first() {
        let url = base("https://wildflowerhealth.io/app").route_url(
            "/gatekeeper/devices",
            SERVER,
            &[("user_code", "ABCD-EFGH")],
        );
        assert_eq!(
            url.as_str(),
            "https://wildflowerhealth.io/app/gatekeeper/devices\
             ?server=http%3A%2F%2F127.0.0.1%3A8080&user_code=ABCD-EFGH"
        );
    }

    #[test]
    fn route_url_keeps_percent_encoded_segments() {
        let url = base("https://wildflowerhealth.io/app/").route_url(
            "/gatekeeper/devices/a%20b",
            SERVER,
            &[],
        );
        assert_eq!(url.path(), "/app/gatekeeper/devices/a%20b");
        assert_eq!(
            url.path_segments().and_then(|mut s| s.next_back()),
            Some("a%20b")
        );
    }

    #[test]
    fn open_url_round_trips_server_and_return_to() {
        let return_to = "/settings/tunnel?tab=a&b=c#frag";
        let url = base("https://wildflowerhealth.io/app").open_url(SERVER, return_to);
        assert_eq!(url.path(), "/app/");
        let pairs: Vec<(String, String)> = url.query_pairs().into_owned().collect();
        assert_eq!(
            pairs,
            vec![
                ("server".to_owned(), SERVER.to_owned()),
                ("returnTo".to_owned(), return_to.to_owned()),
            ]
        );
        assert_eq!(url.fragment(), None);
    }
}
