//! macOS cookie seeding that never pumps the main run loop.
//!
//! wry's `Webview::set_cookie` re-entrantly spins the main `NSRunLoop` inside
//! tao's event handler and self-deadlocks the app. This module bypasses it,
//! firing `WKHTTPCookieStore.setCookie(_:completionHandler:)` on the main thread
//! but **asynchronously** and running the caller's follow-up work from the
//! completion block. Why that is the only shape that works — and why moving the
//! call off the main thread was never the fix — is in
//! [docs/Lifecycle and Races Explanation.md](../../docs/Lifecycle%20and%20Races%20Explanation.md)
//! § "Cookie seeding must not pump the main run loop".
//!
//! **The default data store** is the right jar, not a widening of scope: wry
//! builds every webview against `WKWebsiteDataStore::defaultDataStore` unless
//! asked for incognito or a custom identifier, and this plugin asks for neither.
//! The popup's two webviews and the main app window already share it, and it is
//! what the old `set_cookie` path wrote into.
//!
//! **Unsafe**: this is the crate's only `unsafe` island (see the crate's
//! `[lints.rust]` block). Everything here is Objective-C messaging through
//! `objc2` — `unsafe` because the bindings are, not because an invariant is
//! being hand-waved. Each block says what makes it sound.

#![allow(unsafe_code)]

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::MainThreadMarker;
use objc2_foundation::{
    ns_string, NSArray, NSHTTPCookie, NSHTTPCookieDomain, NSHTTPCookieMaximumAge, NSHTTPCookieName,
    NSHTTPCookiePath, NSHTTPCookiePropertyKey, NSHTTPCookieSecure, NSHTTPCookieValue,
    NSHTTPCookieVersion, NSMutableDictionary, NSString,
};
use objc2_web_kit::{WKHTTPCookieStore, WKWebsiteDataStore};

use crate::models::{CookieSameSite, CookieSpec};

/// The property dictionary `NSHTTPCookie::cookieWithProperties` is built from —
/// a port of wry's `cookie_into_wkwebview` (`wry-0.55.1`
/// `src/wkwebview/mod.rs:1106`) specialised to [`CookieSpec`]'s always-present
/// fields.
///
/// Two of the keys are **private** (`HttpOnly`, `SameSite`): Foundation exports
/// no `NSHTTPCookie*` constant for either, and the documented
/// `NSHTTPCookieSameSitePolicy` key is not what WebKit reads back. They are
/// load-bearing for the owner-session pair (`wf_auth` must stay invisible to
/// page JS), so they are spelled out here exactly as wry spells them.
///
/// `Secure` / `HttpOnly` are inserted **only when true**, never as `"FALSE"`:
/// Foundation keys off a property's *presence*, so a present-but-`FALSE`
/// `HttpOnly` still lands the cookie HttpOnly. This mirrors the `Option`
/// discipline the old `cookies::cookie_from_spec` used for the same reason.
fn cookie_properties(
    spec: &CookieSpec,
) -> Retained<NSMutableDictionary<NSHTTPCookiePropertyKey, AnyObject>> {
    let name = NSString::from_str(&spec.name);
    let value = NSString::from_str(&spec.value);
    let path = NSString::from_str(&spec.path);
    let domain = NSString::from_str(&spec.domain);

    // SAFETY: the `NSHTTPCookie*` keys are Foundation's own exported string
    // constants. Reading them is `unsafe` only because they are `extern "C"`
    // statics; they are initialised before any Rust code runs.
    let (name_key, value_key, path_key, domain_key) = unsafe {
        (
            NSHTTPCookieName,
            NSHTTPCookieValue,
            NSHTTPCookiePath,
            NSHTTPCookieDomain,
        )
    };
    let properties: Retained<NSMutableDictionary<NSHTTPCookiePropertyKey, AnyObject>> =
        NSMutableDictionary::from_slices(
            &[name_key, value_key, path_key, domain_key],
            &[&*name, &*value, &*path, &*domain],
        );

    if let Some(seconds) = spec.max_age {
        let max_age = NSString::from_str(&seconds.to_string());
        // SAFETY: as above — exported Foundation constants.
        let (max_age_key, version_key) = unsafe { (NSHTTPCookieMaximumAge, NSHTTPCookieVersion) };
        properties.insert(max_age_key, &*max_age);
        // `Max-Age` is an RFC-2965 attribute, so the cookie must declare v1 —
        // Foundation ignores `NSHTTPCookieMaximumAge` on a v0 cookie.
        properties.insert(version_key, ns_string!("1"));
    }

    if spec.secure {
        // SAFETY: as above — an exported Foundation constant.
        let secure_key = unsafe { NSHTTPCookieSecure };
        properties.insert(secure_key, ns_string!("TRUE"));
    }

    if spec.http_only {
        properties.insert(ns_string!("HttpOnly"), ns_string!("TRUE"));
    }

    // Lowercase values, matching wry — WebKit compares these case-sensitively
    // (tauri-apps/wry#1616). `None` omits the key entirely, which is how
    // Foundation spells "no SameSite restriction".
    match spec.same_site {
        CookieSameSite::Lax => properties.insert(ns_string!("SameSite"), ns_string!("lax")),
        CookieSameSite::Strict => properties.insert(ns_string!("SameSite"), ns_string!("strict")),
        CookieSameSite::None => {}
    }

    properties
}

/// Build the `NSHTTPCookie` for `spec`. `None` when Foundation rejects the
/// property set (a missing required key or an illegal value) — the caller logs
/// and drops that one cookie rather than failing the whole launch.
fn cookie_from_spec(spec: &CookieSpec) -> Option<Retained<NSHTTPCookie>> {
    let properties = cookie_properties(spec);
    // SAFETY: `properties` is an `NSHTTPCookiePropertyKey` → `NSString`
    // dictionary, which is the shape `cookieWithProperties:` documents; the
    // generic parameters on the Rust side say the same thing.
    unsafe { NSHTTPCookie::cookieWithProperties(&properties) }
}

/// The process-global cookie jar every webview in this app shares (see the
/// module doc).
fn default_cookie_store(mtm: MainThreadMarker) -> Retained<WKHTTPCookieStore> {
    // SAFETY: both calls are main-thread-only, which `mtm` witnesses.
    unsafe { WKWebsiteDataStore::defaultDataStore(mtm).httpCookieStore() }
}

/// Write every cookie in `specs` into the default cookie store and run
/// `on_committed` once the last write has landed.
///
/// MUST be called on the main thread (`mtm` is the witness). Nothing here
/// blocks: each `setCookie:completionHandler:` returns immediately, the
/// completions arrive on later, non-nested main-loop iterations, and an
/// [`AtomicUsize`] counts them down so `on_committed` runs exactly once — after
/// the final write. That is the whole point of this module; see the module doc
/// for the deadlock it avoids.
///
/// `on_committed` still runs when `specs` is empty or every spec is rejected, so
/// a caller that parks a webview at `about:blank` pending the seed is never left
/// stranded there.
pub(super) fn seed_default_store_then<F>(
    specs: &[CookieSpec],
    mtm: MainThreadMarker,
    on_committed: F,
) where
    F: FnOnce() + 'static,
{
    let cookies: Vec<Retained<NSHTTPCookie>> = specs
        .iter()
        .filter_map(|spec| {
            let cookie = cookie_from_spec(spec);
            if cookie.is_none() {
                log::error!(
                    "[native-webview] cookie {:?} rejected by NSHTTPCookie — dropping it",
                    spec.name
                );
            }
            cookie
        })
        .collect();

    if cookies.is_empty() {
        on_committed();
        return;
    }

    let store = default_cookie_store(mtm);
    let remaining = Arc::new(AtomicUsize::new(cookies.len()));
    // `on_committed` is `FnOnce` but a block is `Fn`, so it lives in a slot the
    // winning completion takes it out of. Every completion runs on the main
    // thread, so the lock is never actually contended — it is here to satisfy
    // the shared-mutability requirement, not to arbitrate.
    let pending: Arc<Mutex<Option<F>>> = Arc::new(Mutex::new(Some(on_committed)));

    for cookie in &cookies {
        let remaining = Arc::clone(&remaining);
        let pending = Arc::clone(&pending);
        let completion: RcBlock<dyn Fn()> = RcBlock::new(move || {
            // `fetch_sub` returns the *previous* value, so `1` means this
            // completion is the last one outstanding.
            if remaining.fetch_sub(1, Ordering::SeqCst) != 1 {
                return;
            }
            let Ok(mut slot) = pending.lock() else {
                log::error!("[native-webview] cookie seed completion slot poisoned");
                return;
            };
            if let Some(run) = slot.take() {
                run();
            }
        });
        // SAFETY: `cookie` outlives the call (WebKit copies it), and the block
        // is retained by the runtime for as long as the completion is pending.
        unsafe { store.setCookie_completionHandler(cookie, Some(&completion)) };
    }
}

/// Log the **names** of the default store's cookies scoped to `domain` — the
/// read-back that makes "did `wf_auth` actually land?" answerable from a launch
/// log. Names only, never values: this is observability, not an export of the
/// jar.
///
/// Also async, and for the same reason: wry's `cookies_for_url` reads the store
/// through the very `wait_for_blocking_operation` pump this module exists to
/// avoid, so the read-back must not go through it either.
pub(super) fn log_default_store_names(domain: String, mtm: MainThreadMarker) {
    let store = default_cookie_store(mtm);
    let completion: RcBlock<dyn Fn(std::ptr::NonNull<NSArray<NSHTTPCookie>>)> =
        RcBlock::new(move |cookies: std::ptr::NonNull<NSArray<NSHTTPCookie>>| {
            // SAFETY: WebKit hands the block a live array it owns for the
            // duration of the call; we only read from it here.
            let cookies = unsafe { cookies.as_ref() };
            let names: Vec<String> = cookies
                .to_vec()
                .iter()
                // A `Domain`-scoped cookie reads back with a leading dot
                // (`.example.test`), so compare against the bare host.
                .filter(|cookie| cookie.domain().to_string().trim_start_matches('.') == domain)
                .map(|cookie| cookie.name().to_string())
                .collect();
            log::info!("[native-webview] cookie store for {domain} now holds: {names:?}");
        });
    // SAFETY: the block is retained by the runtime until the completion fires.
    unsafe { store.getAllCookies(&completion) };
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> CookieSpec {
        CookieSpec {
            name: "wf_auth".to_owned(),
            value: "e.y.J".to_owned(),
            domain: "apex.example.test".to_owned(),
            path: "/".to_owned(),
            secure: true,
            http_only: true,
            same_site: CookieSameSite::Lax,
            max_age: Some(3600),
        }
    }

    /// Read one property back off the dictionary as a `String`, so the
    /// assertions below read like the `Set-Cookie` they stand in for.
    fn property(
        properties: &NSMutableDictionary<NSHTTPCookiePropertyKey, AnyObject>,
        key: &NSString,
    ) -> Option<String> {
        properties
            .objectForKey(key)
            .and_then(|object| object.downcast::<NSString>().ok())
            .map(|string| string.to_string())
    }

    /// Every [`CookieSpec`] attribute lands in the property dictionary under the
    /// key Foundation/WebKit actually reads — including the two private ones
    /// (`HttpOnly`, `SameSite`) that carry the owner-session guarantees.
    #[test]
    fn cookie_properties_map_every_attribute() {
        let properties = cookie_properties(&spec());
        // SAFETY: exported Foundation constants (see `cookie_properties`).
        let (name_key, value_key, path_key, domain_key, secure_key, max_age_key, version_key) = unsafe {
            (
                NSHTTPCookieName,
                NSHTTPCookieValue,
                NSHTTPCookiePath,
                NSHTTPCookieDomain,
                NSHTTPCookieSecure,
                NSHTTPCookieMaximumAge,
                NSHTTPCookieVersion,
            )
        };
        assert_eq!(property(&properties, name_key).as_deref(), Some("wf_auth"));
        assert_eq!(property(&properties, value_key).as_deref(), Some("e.y.J"));
        assert_eq!(property(&properties, path_key).as_deref(), Some("/"));
        assert_eq!(
            property(&properties, domain_key).as_deref(),
            Some("apex.example.test")
        );
        assert_eq!(property(&properties, secure_key).as_deref(), Some("TRUE"));
        assert_eq!(property(&properties, max_age_key).as_deref(), Some("3600"));
        // `Max-Age` only applies to a v1 cookie.
        assert_eq!(property(&properties, version_key).as_deref(), Some("1"));
        assert_eq!(
            property(&properties, ns_string!("HttpOnly")).as_deref(),
            Some("TRUE")
        );
        assert_eq!(
            property(&properties, ns_string!("SameSite")).as_deref(),
            Some("lax")
        );
    }

    /// The false/absent cases are the security-relevant ones: a `FALSE` value
    /// would still land the attribute (Foundation keys off presence), so the
    /// mapping must omit the key entirely. `SameSite::None` likewise omits.
    #[test]
    fn cookie_properties_omit_rather_than_negate() {
        let properties = cookie_properties(&CookieSpec {
            secure: false,
            http_only: false,
            same_site: CookieSameSite::None,
            max_age: None,
            ..spec()
        });
        // SAFETY: exported Foundation constants (see `cookie_properties`).
        let (secure_key, max_age_key, version_key) = unsafe {
            (
                NSHTTPCookieSecure,
                NSHTTPCookieMaximumAge,
                NSHTTPCookieVersion,
            )
        };
        assert_eq!(property(&properties, secure_key), None);
        assert_eq!(property(&properties, ns_string!("HttpOnly")), None);
        assert_eq!(property(&properties, ns_string!("SameSite")), None);
        // A session cookie carries no `Max-Age`, and so stays a v0 cookie.
        assert_eq!(property(&properties, max_age_key), None);
        assert_eq!(property(&properties, version_key), None);
    }

    /// The dictionary is one Foundation accepts, and the cookie it builds
    /// reports the attributes back through the public accessors. `isHTTPOnly`
    /// is the one that proves the private `HttpOnly` key did its job.
    #[test]
    fn cookie_from_spec_builds_an_http_only_secure_cookie() {
        let cookie = cookie_from_spec(&spec()).expect("NSHTTPCookie rejected the property set");
        assert_eq!(cookie.name().to_string(), "wf_auth");
        assert_eq!(cookie.value().to_string(), "e.y.J");
        assert_eq!(cookie.path().to_string(), "/");
        assert!(cookie.isSecure());
        assert!(cookie.isHTTPOnly());
        // `Domain`-scoped, so Foundation prefixes the dot.
        assert_eq!(
            cookie.domain().to_string().trim_start_matches('.'),
            "apex.example.test"
        );
    }

    /// A session cookie round-trips as one — no expiry, not `Secure`, not
    /// `HttpOnly`.
    #[test]
    fn cookie_from_spec_builds_a_plain_session_cookie() {
        let cookie = cookie_from_spec(&CookieSpec {
            secure: false,
            http_only: false,
            same_site: CookieSameSite::Strict,
            max_age: None,
            ..spec()
        })
        .expect("NSHTTPCookie rejected the property set");
        assert!(!cookie.isSecure());
        assert!(!cookie.isHTTPOnly());
        assert!(cookie.isSessionOnly());
    }
}
