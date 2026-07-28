//! The `Webview::set_cookie` implementation of the seeding contract, for
//! **Linux and Windows** (see [`super`] for the contract itself, and for why
//! macOS cannot use this).
//!
//! wry's cookie API on these platforms is an ordinary queued write, so the
//! ordering guarantee is the main loop's FIFO: `set_cookie`, `set_cookie`,
//! `navigate` queued in that order land in that order, and every cookie commits
//! before the target's first request. The one requirement is that the writes are
//! queued rather than run inline, which is why this spawns a thread — tauri's
//! `send_user_message` executes inline when it is already on the main thread.

use tauri::{AppHandle, Runtime};
use url::Url;

use crate::desktop::labels::content_label;
use crate::models::CookieSpec;

/// See [`super`] for the contract this implements.
pub(in crate::desktop) fn seed_then_navigate<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    cookies: Vec<CookieSpec>,
    target: Url,
) -> crate::Result<()> {
    use tauri::Manager;

    let handle = app.clone();
    let id = id.to_owned();
    std::thread::spawn(move || {
        let Some(content) = handle.get_webview(&content_label(&id)) else {
            log::warn!("[native-webview] cookie seed skipped: instance {id} is already gone");
            return;
        };
        if let Err(error) = seed_cookies(&content, &cookies) {
            log::error!("[native-webview] cookie seed failed: {error}");
            // Still navigate: an un-authenticated page beats a webview stuck at
            // `about:blank`.
        }
        if let Err(error) = content.navigate(target) {
            log::error!("[native-webview] navigate after cookie seed failed: {error}");
        }
    });
    Ok(())
}

/// Convert a wire [`CookieSpec`] into the typed [`tauri::webview::cookie`]
/// `Cookie` handed to `Webview::set_cookie`. Pure field mapping — attribute
/// grammar stays the vetted cookie crate's.
///
fn cookie_from_spec(spec: &CookieSpec) -> tauri::webview::cookie::Cookie<'static> {
    use crate::models::CookieSameSite;
    use tauri::webview::cookie::{time::Duration, Cookie, SameSite};
    let mut cookie = Cookie::new(spec.name.clone(), spec.value.clone());
    cookie.set_domain(spec.domain.clone());
    cookie.set_path(spec.path.clone());
    // Boolean attributes are set only when TRUE: `set_http_only(false)` records
    // `Some(false)`, which the backends' cookie conversions map to a *present*
    // native property, and the platform stores key off presence — so a
    // `Some(false)` `wf_auth_exp` lands HttpOnly, hidden from the consent page's
    // JS. `None` keeps it off. Same for `Secure`.
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
/// thread: each `set_cookie` is a message the main loop processes on its own
/// FIFO iteration, so a `navigate` queued after this runs only once every cookie
/// has committed — the seeding contract (see docs/Explanation.md).
fn seed_cookies<R: Runtime>(
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
    use crate::models::CookieSameSite;

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
        // MUST be `None`, not `Some(false)` — see `cookie_from_spec` (the native
        // stores key off property presence, so `Some(false)` lands HttpOnly).
        assert_eq!(cookie.http_only(), None);
        assert_eq!(cookie.secure(), None);
    }
}
