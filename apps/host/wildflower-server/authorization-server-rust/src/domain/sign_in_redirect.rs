//! Where `GET /oauth/sign-in` may send a browser once it has signed the Owner
//! in: its `next`, held to an allow-list. [`SignInDestinations`] is the
//! allow-list, and [`SignInRedirect`] a `next` it allowed.
//!
//! A `next` is allowed when it is
//!
//! - a path on this server: it starts with `/` but not `//`, and still names
//!   this server's origin once resolved against it;
//! - a URL under the hosted launcher ([`LauncherBase`]);
//! - a URL under the Wildflower Authorization app ([`AuthorizationAppBase`]).
//!
//! Each is judged by the URL a browser would make of it, parsed as the WHATWG
//! URL standard says, so the spellings a browser reads as another host
//! (`/\evil.example`, a tab inside `//`, `user@host`) resolve to that host here
//! too and are refused. The redirect is that parsed URL re-serialized, never
//! the raw `next`.

use url::{Position, Url};
use wildflowerhealthio_shared_structures::authorization_app::AuthorizationAppBase;
use wildflowerhealthio_shared_structures::launcher::LauncherBase;

/// The places a sign-in may send a browser on to.
pub(crate) struct SignInDestinations {
    /// This server's origin, which a path `next` must stay on.
    server_origin: Url,
    launcher: LauncherBase,
    authorization_app: AuthorizationAppBase,
}

/// A `next` [`SignInDestinations`] allowed: the `Location` the sign-in
/// answers with. A path on this server stays a path, so the browser stays on
/// whichever origin it reached the server at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SignInRedirect(String);

impl SignInRedirect {
    /// The `Location` to send the browser to.
    pub(crate) fn location(&self) -> &str {
        &self.0
    }
}

impl SignInDestinations {
    /// The paths on `server_origin`, and the URLs under `launcher` and under
    /// `authorization_app`.
    pub(crate) fn new(
        server_origin: Url,
        launcher: LauncherBase,
        authorization_app: AuthorizationAppBase,
    ) -> Self {
        SignInDestinations {
            server_origin,
            launcher,
            authorization_app,
        }
    }

    /// `next` as a redirect, when it is one of the allowed places; `None`
    /// otherwise.
    pub(crate) fn allow(&self, next: &str) -> Option<SignInRedirect> {
        if next.starts_with('/') {
            return self.path_on_this_server(next);
        }
        let url = Url::parse(next).ok()?;
        let is_allowed = is_under(&url, self.launcher.as_url())
            || is_under(&url, self.authorization_app.as_url());
        is_allowed.then(|| SignInRedirect(url.into()))
    }

    /// `next`, a path, resolved against this server: its path and query, when
    /// it still names this server's origin.
    fn path_on_this_server(&self, next: &str) -> Option<SignInRedirect> {
        if next.starts_with("//") {
            return None;
        }
        let resolved = self.server_origin.join(next).ok()?;
        (resolved.origin() == self.server_origin.origin())
            .then(|| SignInRedirect(resolved[Position::BeforePath..].to_owned()))
    }
}

/// Whether `url` is `base` or below it: the same origin, no credentials, and a
/// path within `base`'s (which ends in `/`).
fn is_under(url: &Url, base: &Url) -> bool {
    url.origin() == base.origin()
        && url.username().is_empty()
        && url.password().is_none()
        && url.path().starts_with(base.path())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SERVER_ORIGIN: &str = "https://ruth.relay.example";

    fn destinations() -> SignInDestinations {
        SignInDestinations::new(
            Url::parse(SERVER_ORIGIN).expect("server origin"),
            LauncherBase::parse("https://site.example/launcher/").expect("launcher"),
            AuthorizationAppBase::parse("https://site.example/authorization/")
                .expect("authorization app"),
        )
    }

    fn allowed(next: &str) -> Option<String> {
        destinations()
            .allow(next)
            .map(|redirect| redirect.location().to_owned())
    }

    #[test]
    fn a_path_on_this_server_is_allowed_as_a_path() {
        assert_eq!(
            allowed("/oauth/authorize/req-1/consent?x=1").as_deref(),
            Some("/oauth/authorize/req-1/consent?x=1")
        );
        assert_eq!(allowed("/").as_deref(), Some("/"));
        assert_eq!(allowed("/a/../b").as_deref(), Some("/b"), "normalized");
    }

    #[test]
    fn a_path_naming_another_host_is_refused() {
        for next in [
            "//evil.example",
            "//evil.example/oauth",
            "/\\evil.example",
            "/\\/evil.example",
            "/\t/evil.example",
            "/\n/evil.example",
        ] {
            assert_eq!(allowed(next), None, "{next:?}");
        }
    }

    #[test]
    fn a_launcher_url_is_allowed() {
        assert_eq!(
            allowed("https://site.example/launcher/?server=https%3A%2F%2Fruth.relay.example")
                .as_deref(),
            Some("https://site.example/launcher/?server=https%3A%2F%2Fruth.relay.example")
        );
        assert_eq!(
            allowed("https://site.example/launcher/settings").as_deref(),
            Some("https://site.example/launcher/settings")
        );
    }

    #[test]
    fn an_authorization_app_url_is_allowed() {
        assert_eq!(
            allowed("https://site.example/authorization/?iss=https%3A%2F%2Fruth.relay.example")
                .as_deref(),
            Some("https://site.example/authorization/?iss=https%3A%2F%2Fruth.relay.example")
        );
    }

    #[test]
    fn any_other_url_is_refused() {
        for next in [
            "https://evil.example/launcher/",
            // The allowed origin, outside both bases.
            "https://site.example/",
            "https://site.example/launcherx/",
            "https://site.example/launcher",
            "https://site.example/launcher/../evil/",
            "https://site.example/launcher/%2e%2e/evil/",
            // Another scheme or port on the allowed host.
            "http://site.example/launcher/",
            "https://site.example:8443/launcher/",
            // Credentials, and a host hidden behind them.
            "https://user@site.example/launcher/",
            "https://site.example@evil.example/launcher/",
            // This server, absolutely: only paths are allowed here.
            "https://ruth.relay.example/",
            "javascript:alert(1)",
            "evil.example",
            "",
        ] {
            assert_eq!(allowed(next), None, "{next:?}");
        }
    }
}
