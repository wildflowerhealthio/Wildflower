//! Cookie seeding: map the wire [`CookieSpec`] onto the typed cookie crate's
//! `Cookie` and queue it onto the content webview's store before its first
//! navigation.

use tauri::Runtime;

use crate::models::{CookieSameSite, CookieSpec};

/// Convert a wire [`CookieSpec`] into the typed [`tauri::webview::cookie`]
/// `Cookie` handed to `Webview::set_cookie`. Pure field mapping — attribute
/// grammar stays the vetted cookie crate's.
pub(super) fn cookie_from_spec(spec: &CookieSpec) -> tauri::webview::cookie::Cookie<'static> {
    use tauri::webview::cookie::{time::Duration, Cookie, SameSite};
    let mut cookie = Cookie::new(spec.name.clone(), spec.value.clone());
    cookie.set_domain(spec.domain.clone());
    cookie.set_path(spec.path.clone());
    // Boolean attributes are set only when TRUE: `set_http_only(false)` records
    // `Some(false)`, which wry's macOS conversion maps to a *present* NSHTTPCookie
    // property, and Foundation keys off presence — so a `Some(false)` `wf_auth_exp`
    // lands HttpOnly, hidden from the consent page's JS. `None` keeps it off. Same
    // for `Secure`.
    if spec.secure {
        cookie.set_secure(true);
    }
    if spec.http_only {
        cookie.set_http_only(true);
    }
    cookie.set_same_site(match spec.same_site {
        CookieSameSite::Strict => SameSite::Strict,
        CookieSameSite::Lax => SameSite::Lax,
        CookieSameSite::None => SameSite::None,
    });
    if let Some(seconds) = spec.max_age {
        cookie.set_max_age(Duration::seconds(seconds));
    }
    cookie
}

/// Queue `cookies` onto `content`'s cookie store. MUST be called OFF the main
/// thread: each `set_cookie` is a fire-and-forget message the main loop processes
/// on its own FIFO iteration, so a `navigate` queued after this runs only once
/// every cookie has committed — the seeding contract (see docs/Explanation.md).
/// Calling this ON the main thread executes the wry write inline, nesting its
/// run-loop pump inside tao's event handler and deadlocking the app (macOS).
pub(super) fn seed_cookies<R: Runtime>(
    content: &tauri::webview::Webview<R>,
    cookies: &[CookieSpec],
) -> crate::Result<()> {
    for spec in cookies {
        content.set_cookie(cookie_from_spec(spec))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every [`CookieSpec`] attribute lands on the typed cookie — asserted on
    /// the rendered `Set-Cookie` grammar (the whole value, not field-by-field)
    /// so an attribute the mapping dropped or renamed fails loudly.
    #[test]
    fn cookie_from_spec_maps_every_attribute() {
        let cookie = cookie_from_spec(&CookieSpec {
            name: "wf_auth".to_owned(),
            value: "e.y.J".to_owned(),
            domain: "apex.example.test".to_owned(),
            path: "/".to_owned(),
            secure: true,
            http_only: true,
            same_site: CookieSameSite::Lax,
            max_age: Some(3600),
        });
        assert_eq!(
            cookie.to_string(),
            "wf_auth=e.y.J; HttpOnly; SameSite=Lax; Secure; Path=/; \
             Domain=apex.example.test; Max-Age=3600"
        );
    }

    /// `max_age: None` yields a session cookie (no `Max-Age`), and the boolean
    /// attributes render as absent rather than negated.
    #[test]
    fn cookie_from_spec_session_cookie_omits_max_age() {
        let cookie = cookie_from_spec(&CookieSpec {
            name: "n".to_owned(),
            value: "v".to_owned(),
            domain: "example.test".to_owned(),
            path: "/p".to_owned(),
            secure: false,
            http_only: false,
            same_site: CookieSameSite::Strict,
            max_age: None,
        });
        assert_eq!(
            cookie.to_string(),
            "n=v; SameSite=Strict; Path=/p; Domain=example.test"
        );
        // MUST be `None`, not `Some(false)` — see `cookie_from_spec` (Foundation
        // keys off property presence, so `Some(false)` lands HttpOnly).
        assert_eq!(cookie.http_only(), None);
        assert_eq!(cookie.secure(), None);
    }
}
