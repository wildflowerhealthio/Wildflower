//! Where `GET /oauth/sign-in` may send a browser once it has signed the Owner
//! in: its `next`, held to an allow-list. [`SignInDestinations`] is the
//! allow-list, and [`SignInRedirect`] a `next` it allowed.
//!
//! A `next` is allowed when it is
//!
//! - a path on this server: it starts with `/` but not `//`, and still names
//!   this server's origin once resolved against it;
//! - a URL under the hosted launcher ([`LauncherBase`]);
//! - a URL under the Wildflower Authorization app ([`AuthorizationAppBase`]);
//! - a URL under the pages the host opens for this server, its own launcher
//!   and Authorization app: the page itself, whatever its query, or a URL
//!   within it as a folder.
//!
//! Each is judged by the URL a browser would make of it, parsed as the WHATWG
//! URL standard says, so the spellings a browser reads as another host
//! (`/\evil.example`, a tab inside `//`, `user@host`) resolve to that host here
//! too and are refused. The redirect is that parsed URL re-serialized, never
//! the raw `next`.

use url::{Position, Url};
use wildflowerhealthio_shared_structures::authorization_app::AuthorizationAppBase;
use wildflowerhealthio_shared_structures::launcher::LauncherBase;

/// The places a sign-in may send a browser on to: this server's origin, which
/// a path must stay on, and the four pages a URL may be under. Built once at
/// setup from the server's configuration.
pub(crate) struct SignInDestinations {
    /// This server's origin, which a path `next` must stay on.
    server_origin: Url,
    /// The hosted launcher: a URL under it is allowed.
    launcher: LauncherBase,
    /// The hosted Wildflower Authorization app: a URL under it is allowed.
    authorization_app: AuthorizationAppBase,
    /// The page the host opens this server's launches in; it is allowed
    /// whatever its query, and so are the URLs within it.
    launcher_url: Url,
    /// The page the host opens this server's Authorization app at; it is
    /// allowed whatever its query, and so are the URLs within it.
    authorization_url: Url,
}

/// A `next` [`SignInDestinations`] allowed: the `Location` the sign-in
/// answers with. A path on this server stays a path, so the browser stays on
/// the server's origin. Only [`SignInDestinations`] makes one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SignInRedirect(
    /// The `Location` value: a path and query on this server, or an absolute
    /// URL, re-serialized from the parsed `next`.
    String,
);

impl SignInRedirect {
    /// The `Location` to send the browser to.
    pub(crate) fn location(&self) -> &str {
        &self.0
    }
}

impl SignInDestinations {
    /// The paths on `server_origin`, and the URLs under `launcher`,
    /// `authorization_app`, `launcher_url` and `authorization_url`.
    pub(crate) fn new(
        server_origin: Url,
        launcher: LauncherBase,
        authorization_app: AuthorizationAppBase,
        launcher_url: Url,
        authorization_url: Url,
    ) -> Self {
        SignInDestinations {
            server_origin,
            launcher,
            authorization_app,
            launcher_url,
            authorization_url,
        }
    }

    /// `next` as a redirect, when it is one of the allowed places; `None`
    /// otherwise.
    pub(crate) fn allow(&self, next: &str) -> Option<SignInRedirect> {
        if next.starts_with('/') {
            return self.path_on_this_server(next);
        }
        let url = Url::parse(next).ok()?;
        let is_allowed = [
            self.launcher.as_url(),
            self.authorization_app.as_url(),
            &self.launcher_url,
            &self.authorization_url,
        ]
        .into_iter()
        .any(|page| is_under(&url, page));
        is_allowed.then(|| SignInRedirect(url.into()))
    }

    /// `next` as a redirect, when it is a path on this server; `None`
    /// otherwise. A browser pairing's `next` must be one: a paired browser
    /// is sent on to the server's own `/oauth/authorize`, never off it.
    pub(crate) fn allow_on_this_server(&self, next: &str) -> Option<SignInRedirect> {
        if next.starts_with('/') {
            self.path_on_this_server(next)
        } else {
            None
        }
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

/// Whether `url` is `page` or below it: the same origin, no credentials, and
/// `page`'s path or a path within it as a folder. A base's path ends in `/`,
/// so only the paths within it are.
fn is_under(url: &Url, page: &Url) -> bool {
    let folder = if page.path().ends_with('/') {
        page.path().to_owned()
    } else {
        format!("{}/", page.path())
    };
    url.origin() == page.origin()
        && url.username().is_empty()
        && url.password().is_none()
        && (url.path() == page.path() || url.path().starts_with(&folder))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The origin of the server the tests judge against.
    const SERVER_ORIGIN: &str = "https://ruth.relay.example";

    /// The allow-list the tests judge against: the server at
    /// [`SERVER_ORIGIN`], a hosted launcher and Authorization app under paths
    /// of `https://site.example`, and the host's own launcher page (with a
    /// query) and Authorization page on two more origins.
    fn destinations() -> SignInDestinations {
        SignInDestinations::new(
            Url::parse(SERVER_ORIGIN).expect("server origin"),
            LauncherBase::parse("https://site.example/launcher/").expect("launcher"),
            AuthorizationAppBase::parse("https://site.example/authorization/")
                .expect("authorization app"),
            Url::parse("https://apps.example/launcher?theme=dark").expect("launcher URL"),
            Url::parse("https://manage.example/authorization/").expect("authorization URL"),
        )
    }

    /// The `Location` `next` would get from [`destinations`], or `None`.
    fn allowed(next: &str) -> Option<String> {
        destinations()
            .allow(next)
            .map(|redirect| redirect.location().to_owned())
    }

    /// The published launcher and Authorization app each sit at the root of
    /// an origin of their own: everything on that origin is under them, and
    /// nothing on a sibling origin or the parent domain is.
    #[test]
    fn a_base_at_an_origin_root_allows_that_origin_only() {
        let destinations = SignInDestinations::new(
            Url::parse(SERVER_ORIGIN).expect("server origin"),
            LauncherBase::parse("https://launcher.site.example").expect("launcher"),
            AuthorizationAppBase::parse("https://authorization.site.example/")
                .expect("authorization app"),
            Url::parse("https://launcher.site.example/").expect("launcher URL"),
            Url::parse("https://authorization.site.example/").expect("authorization URL"),
        );
        let allowed = |next: &str| {
            destinations
                .allow(next)
                .map(|redirect| redirect.location().to_owned())
        };
        for next in [
            "https://launcher.site.example/?server=https%3A%2F%2Fruth.relay.example",
            "https://launcher.site.example/settings/requests",
            "https://authorization.site.example/grants",
        ] {
            assert_eq!(allowed(next).as_deref(), Some(next), "{next:?}");
        }
        for next in [
            "https://site.example/",
            "https://medications.site.example/",
            "https://launcher.site.example.evil/",
            "https://evil.launcher.site.example/",
            "http://launcher.site.example/",
        ] {
            assert_eq!(allowed(next), None, "{next:?}");
        }
    }

    /// A path keeps its query, `/` is allowed, and `/a/../b` comes back
    /// normalized as `/b`.
    #[test]
    fn a_path_on_this_server_is_allowed_as_a_path() {
        assert_eq!(
            allowed("/oauth/authorize/req-1/consent?x=1").as_deref(),
            Some("/oauth/authorize/req-1/consent?x=1")
        );
        assert_eq!(allowed("/").as_deref(), Some("/"));
        assert_eq!(allowed("/a/../b").as_deref(), Some("/b"), "normalized");
    }

    /// `//host`, a backslash after the slash, and a tab or newline between the
    /// slashes all resolve to another host, and are refused.
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

    /// The hosted launcher's base, with a query, and a page within it are
    /// allowed as given.
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

    /// The hosted Authorization app's base, with a query, is allowed as given.
    #[test]
    fn an_authorization_app_url_is_allowed() {
        assert_eq!(
            allowed("https://site.example/authorization/?iss=https%3A%2F%2Fruth.relay.example")
                .as_deref(),
            Some("https://site.example/authorization/?iss=https%3A%2F%2Fruth.relay.example")
        );
    }

    /// The host's launcher page is allowed with any query (a launch adds `iss`
    /// and `launch`), without one, and with a path within it; the host's
    /// Authorization page likewise.
    #[test]
    fn a_url_under_the_server_s_own_launcher_or_authorization_app_is_allowed() {
        for next in [
            // A launch: the launcher page, its own query, `iss` and `launch`.
            "https://apps.example/launcher?theme=dark&iss=https%3A%2F%2Fruth.relay.example&launch=n1",
            "https://apps.example/launcher",
            "https://apps.example/launcher/settings",
            "https://manage.example/authorization/?iss=https%3A%2F%2Fruth.relay.example",
            "https://manage.example/authorization/grants",
        ] {
            assert_eq!(allowed(next).as_deref(), Some(next), "{next:?}");
        }
    }

    /// A sibling path that only shares a prefix, the bare origin, another
    /// path, `http`, credentials, and the Authorization page without its
    /// trailing slash are all refused.
    #[test]
    fn a_url_outside_the_server_s_own_launcher_and_authorization_app_is_refused() {
        for next in [
            "https://apps.example/",
            "https://apps.example/launcherx",
            "https://apps.example/launcher.html",
            "https://apps.example/other?theme=dark",
            "http://apps.example/launcher",
            "https://user@apps.example/launcher",
            "https://manage.example/",
            "https://manage.example/authorization",
            "https://manage.example/authorizations/",
        ] {
            assert_eq!(allowed(next), None, "{next:?}");
        }
    }

    /// Everything else is refused: another origin, the allowed origin outside
    /// both bases, a `..` that climbs out (encoded or not), another scheme or
    /// port, credentials or a host hidden behind them, this server as an
    /// absolute URL, `javascript:`, a bare host and the empty string.
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

    /// A pairing's `next` is a path on this server, as a sign-in's may be,
    /// and nothing else: not the launcher or Authorization app a sign-in may
    /// also go on to, nor a path naming another host.
    #[test]
    fn only_a_path_on_this_server_is_allowed_on_this_server() {
        let on_this_server = |next: &str| {
            destinations()
                .allow_on_this_server(next)
                .map(|redirect| redirect.location().to_owned())
        };
        assert_eq!(
            on_this_server("/oauth/authorize?client_id=app&state=s").as_deref(),
            Some("/oauth/authorize?client_id=app&state=s")
        );
        for next in [
            "https://site.example/launcher/",
            "https://manage.example/authorization/",
            "https://ruth.relay.example/oauth/authorize",
            "//evil.example/oauth/authorize",
            "/\\evil.example",
            "javascript:alert(1)",
            "",
        ] {
            assert_eq!(on_this_server(next), None, "{next:?}");
        }
    }
}
