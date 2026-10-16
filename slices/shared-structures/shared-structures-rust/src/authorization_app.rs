//! Where the Wildflower Authorization app lives, and the link to it a server
//! advertises.
//!
//! The Wildflower Authorization app is published at a fixed address —
//! `https://authorization.wildflowerhealth.io/` — and is a SMART client of
//! whichever Wildflower server its `?iss=` query parameter names. There the
//! Owner reads and edits what a server has authorized, so a server's SMART
//! discovery advertises it, pointed back at that server, as its
//! `management_endpoint`.
//!
//! [`AuthorizationAppBase`] is the one place that link is spelled. The host
//! decides the base (from `tauri-shared-config.json`) and threads it in; slices
//! never name the address.

use url::Url;

use crate::launcher::directory_url;

/// The query parameter the app reads the server's SMART issuer from, as an EHR
/// launch names it.
const ISS_PARAM: &str = "iss";

/// The root URL of the hosted Wildflower Authorization app, e.g.
/// `https://authorization.wildflowerhealth.io/`.
///
/// Always stored with a trailing slash, and without a query or fragment, like
/// [`LauncherBase`](crate::launcher::LauncherBase).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthorizationAppBase(Url);

impl AuthorizationAppBase {
    /// Parse the app's root, adding the trailing slash if it is missing.
    ///
    /// # Errors
    ///
    /// Returns the [`url::ParseError`] when `base` is not an absolute URL.
    pub fn parse(base: &str) -> Result<Self, url::ParseError> {
        directory_url(base).map(Self)
    }

    /// The app's root itself.
    #[must_use]
    pub fn as_url(&self) -> &Url {
        &self.0
    }

    /// The app, pointed at the server whose SMART issuer is `issuer`: where
    /// the Owner manages what that server has authorized.
    #[must_use]
    pub fn management_url(&self, issuer: &str) -> Url {
        let mut url = self.0.clone();
        url.query_pairs_mut().append_pair(ISS_PARAM, issuer);
        url
    }
}

#[cfg(test)]
mod tests {
    use super::AuthorizationAppBase;

    fn base(raw: &str) -> AuthorizationAppBase {
        AuthorizationAppBase::parse(raw).expect("valid base")
    }

    #[test]
    fn parse_adds_the_trailing_slash_and_drops_query_and_fragment() {
        assert_eq!(
            base("https://authorization.wildflowerhealth.io/pr-7?x=1#y")
                .as_url()
                .as_str(),
            "https://authorization.wildflowerhealth.io/pr-7/"
        );
        assert_eq!(
            base("https://authorization.wildflowerhealth.io?x=1#y")
                .as_url()
                .as_str(),
            "https://authorization.wildflowerhealth.io/"
        );
    }

    #[test]
    fn parse_rejects_a_relative_base() {
        assert!(AuthorizationAppBase::parse("/authorization/").is_err());
    }

    #[test]
    fn management_url_points_the_app_at_the_issuer() {
        let url = base("https://authorization.wildflowerhealth.io")
            .management_url("https://ruth.wildflowerhealth.io");
        assert_eq!(
            url.as_str(),
            "https://authorization.wildflowerhealth.io/?iss=https%3A%2F%2Fruth.wildflowerhealth.io"
        );
    }
}
