//! Pre-navigation cookie seeding, and the "seed then navigate" step that pairs
//! with it.
//!
//! [`seed_then_navigate`] is the single entry point both cookie-carrying open
//! paths use ([`super::NativeWebview::open_url`]'s build/rewire branch and the
//! `CloseRequested` deferred replay in [`super::lifecycle`]). Its two
//! implementations differ in the one thing that matters — how the write reaches
//! WebKit:
//!
//! - **macOS** writes `WKHTTPCookieStore` asynchronously and navigates from the
//!   completion block. wry's `Webview::set_cookie` cannot be used here at all;
//!   see [`super::cookie_store`].
//! - **Everything else desktop** keeps the wry path (`Webview::set_cookie` +
//!   `navigate`) on a spawned thread, where the writes and the navigation queue
//!   onto the main loop in FIFO order.

use tauri::{AppHandle, Runtime};
use url::Url;

use super::labels::content_label;
use crate::models::CookieSpec;

/// Write `cookies` into instance `id`'s cookie jar and navigate its content
/// webview to `target` once they have committed.
///
/// Asynchronous on every platform: it returns as soon as the work is scheduled,
/// so the caller must not treat a successful return as "the cookies are in the
/// jar". Callers park the content webview at `about:blank` first (see
/// [`super::lifecycle::present`]) precisely so the target's first request cannot
/// outrun the seed.
///
/// Safe to call from **either** thread. macOS marshals onto the main thread
/// itself; the other desktop backends spawn, because a wry `set_cookie` issued
/// from the main thread would run inline (see the module doc).
#[cfg(target_os = "macos")]
pub(super) fn seed_then_navigate<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    cookies: Vec<CookieSpec>,
    target: Url,
) -> crate::Result<()> {
    use objc2::MainThreadMarker;
    use tauri::Manager;

    let handle = app.clone();
    let id = id.to_owned();
    app.run_on_main_thread(move || {
        let Some(mtm) = MainThreadMarker::new() else {
            log::error!("[native-webview] cookie seed skipped: not on the main thread");
            return;
        };
        // Every spec in one open is scoped to the same host (the host builds
        // them as a set), so the first one names the jar to read back.
        let read_back = cookies.first().map(|cookie| cookie.domain.clone());
        super::cookie_store::seed_default_store_then(&cookies, mtm, move || {
            match handle.get_webview(&content_label(&id)) {
                Some(content) => {
                    if let Err(error) = content.navigate(target) {
                        log::error!("[native-webview] navigate after cookie seed failed: {error}");
                    }
                }
                // The instance was torn down between the seed and its
                // completion. The cookies are in the (process-global) jar
                // regardless; there is just nothing left to navigate.
                None => log::warn!(
                    "[native-webview] cookie seed committed but instance {id} is already gone"
                ),
            }
            if let Some(domain) = read_back {
                super::cookie_store::log_default_store_names(domain, mtm);
            }
        });
    })?;
    Ok(())
}

/// See the macOS [`seed_then_navigate`] for the contract; this is the wry-backed
/// implementation for the other desktop targets.
#[cfg(not(target_os = "macos"))]
pub(super) fn seed_then_navigate<R: Runtime>(
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
/// macOS does not go through this: it writes `WKHTTPCookieStore` directly (see
/// [`super::cookie_store`]), so the type never gets built there.
#[cfg(not(target_os = "macos"))]
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
#[cfg(not(target_os = "macos"))]
fn seed_cookies<R: Runtime>(
    content: &tauri::webview::Webview<R>,
    cookies: &[CookieSpec],
) -> crate::Result<()> {
    for spec in cookies {
        content.set_cookie(cookie_from_spec(spec))?;
    }
    Ok(())
}

#[cfg(all(test, not(target_os = "macos")))]
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
