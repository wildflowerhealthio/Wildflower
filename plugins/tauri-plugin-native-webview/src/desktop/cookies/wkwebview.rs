//! The `WKHTTPCookieStore` implementation of the seeding contract, for
//! **macOS** (see [`super`] for the contract itself).
//!
//! wry's `Webview::set_cookie` re-entrantly spins the main `NSRunLoop` inside
//! tao's event handler and self-deadlocks the app, so this bypasses it and
//! messages WebKit directly: `setCookie(_:completionHandler:)` fired on the main
//! thread but **asynchronously**, with the navigation issued from the last
//! completion. Why that is the only shape that works — and why moving the call
//! off the main thread was never the fix — is in
//! [docs/Lifecycle and Races Explanation.md](../../../docs/Lifecycle%20and%20Races%20Explanation.md)
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
//! being hand-waved. The opt-out is per-block rather than module-wide, so the
//! `unsafe` surface here is exactly the set of `#[allow(unsafe_code)]` sites
//! below: a new one cannot appear without adding a line that says so, and every
//! such line sits on top of the `SAFETY` note that justifies it.

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
use tauri::{AppHandle, Runtime};
use url::Url;

use crate::desktop::labels::content_label;
use crate::models::{CookieSameSite, CookieSpec};

use super::superseded;

/// See [`super`] for the contract this implements.
pub(in crate::desktop) fn seed_then_navigate<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    cookies: Vec<CookieSpec>,
    target: Url,
    scheduled_at: u64,
) -> crate::Result<()> {
    use tauri::Manager;

    let handle = app.clone();
    let id = id.to_owned();
    app.run_on_main_thread(move || {
        let Some(mtm) = MainThreadMarker::new() else {
            log::error!("[native-webview] cookie seed skipped: not on the main thread");
            return;
        };
        // Check before writing anything, matching the wry implementation: the
        // writes land in the process-global jar, so once they are scheduled
        // there is nothing to withdraw if the instance turns out to be gone.
        if handle.get_webview(&content_label(&id)).is_none() {
            log::warn!("[native-webview] cookie seed skipped: instance {id} is already gone");
            return;
        }
        // Every spec in one open is scoped to the same host (the host builds
        // them as a set), so the first one names the jar to read back.
        let read_back = cookies.first().map(|cookie| cookie.domain.clone());
        seed_default_store_then(&cookies, mtm, move || {
            // Completions arrive on later main-loop iterations, so a newer open
            // can have rewired this instance in between — see
            // [`super::superseded`].
            if superseded(&handle, &id, scheduled_at) {
                log::warn!(
                    "[native-webview] cookie seed for instance {id} committed after a newer open \
                     — not navigating"
                );
            } else {
                match handle.get_webview(&content_label(&id)) {
                    Some(content) => {
                        if let Err(error) = content.navigate(target) {
                            log::error!(
                                "[native-webview] navigate after cookie seed failed: {error}"
                            );
                        }
                    }
                    // The instance was torn down between the seed and its
                    // completion. The cookies are in the (process-global) jar
                    // regardless; there is just nothing left to navigate.
                    None => log::warn!(
                        "[native-webview] cookie seed committed but instance {id} is already gone"
                    ),
                }
            }
            if let Some(domain) = read_back {
                log_default_store_names(domain, mtm);
            }
        });
    })?;
    Ok(())
}

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
    #[allow(unsafe_code)]
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
        #[allow(unsafe_code)]
        let (max_age_key, version_key) = unsafe { (NSHTTPCookieMaximumAge, NSHTTPCookieVersion) };
        properties.insert(max_age_key, &*max_age);
        // `Max-Age` is an RFC-2965 attribute, so the cookie must declare v1 —
        // Foundation ignores `NSHTTPCookieMaximumAge` on a v0 cookie.
        properties.insert(version_key, ns_string!("1"));
    }

    if spec.secure {
        // SAFETY: as above — an exported Foundation constant.
        #[allow(unsafe_code)]
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
    #[allow(unsafe_code)]
    unsafe {
        NSHTTPCookie::cookieWithProperties(&properties)
    }
}

/// The process-global cookie jar every webview in this app shares (see the
/// module doc).
fn default_cookie_store(mtm: MainThreadMarker) -> Retained<WKHTTPCookieStore> {
    // SAFETY: both calls are main-thread-only, which `mtm` witnesses.
    #[allow(unsafe_code)]
    unsafe {
        WKWebsiteDataStore::defaultDataStore(mtm).httpCookieStore()
    }
}

/// The cookie writes still in flight, and what to run when the last one lands.
///
/// `setCookie:completionHandler:` is fired once per cookie and each completion
/// arrives on its own main-loop iteration — WebKit offers no "all done" signal —
/// so the only way to sequence work after the whole batch is to count the
/// completions down. Shared by every completion block, hence the [`Arc`] that
/// [`Self::new`] hands back.
///
/// Nothing here waits. Counting is what *replaces* waiting: blocking for these
/// completions is precisely the deadlock this module exists to avoid (see the
/// module doc).
struct PendingWrites<F> {
    /// Writes not yet reported complete. Reaching zero is the trigger.
    outstanding: AtomicUsize,
    /// The continuation, held in a slot the last completion takes it out of: it
    /// is `FnOnce`, but an Objective-C block is `Fn` and so cannot consume its
    /// captures. Every completion runs on the main thread, so this `Mutex` is
    /// never actually contended — it is here for shared mutability, not to
    /// arbitrate between threads.
    on_all_committed: Mutex<Option<F>>,
}

impl<F: FnOnce()> PendingWrites<F> {
    /// Expect `count` completions, then run `on_all_committed`.
    fn new(count: usize, on_all_committed: F) -> Arc<Self> {
        Arc::new(Self {
            outstanding: AtomicUsize::new(count),
            on_all_committed: Mutex::new(Some(on_all_committed)),
        })
    }

    /// Report one write as committed, running the continuation if this was the
    /// last one outstanding. Every completion block calls exactly this.
    fn record_commit(&self) {
        // `fetch_sub` returns the count from *before* the subtraction, so a
        // previous value of 1 means this call is the one that reached zero.
        let was_last = self.outstanding.fetch_sub(1, Ordering::SeqCst) == 1;
        if !was_last {
            return;
        }
        let Ok(mut slot) = self.on_all_committed.lock() else {
            log::error!("[native-webview] cookie seed continuation slot poisoned");
            return;
        };
        // `take` makes the run-once guarantee structural rather than a promise
        // the count has to keep.
        if let Some(run) = slot.take() {
            run();
        }
    }
}

/// Build the `NSHTTPCookie` batch for `specs`, logging and dropping any single
/// cookie Foundation rejects rather than failing the whole launch.
fn cookies_from_specs(specs: &[CookieSpec]) -> Vec<Retained<NSHTTPCookie>> {
    specs
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
        .collect()
}

/// Write every cookie in `specs` into the default cookie store and run
/// `on_committed` once the last write has landed.
///
/// MUST be called on the main thread (`mtm` is the witness). Nothing here
/// blocks: each `setCookie:completionHandler:` returns immediately and the
/// completions arrive on later, non-nested main-loop iterations, with
/// [`PendingWrites`] counting them down. That is the whole point of this module;
/// see its doc for the deadlock it avoids.
///
/// `on_committed` still runs when `specs` is empty or every spec is rejected, so
/// a caller that parks a webview at `about:blank` pending the seed is never left
/// stranded there.
fn seed_default_store_then<F>(specs: &[CookieSpec], mtm: MainThreadMarker, on_committed: F)
where
    F: FnOnce() + 'static,
{
    let cookies = cookies_from_specs(specs);
    if cookies.is_empty() {
        on_committed();
        return;
    }

    let store = default_cookie_store(mtm);
    let pending = PendingWrites::new(cookies.len(), on_committed);

    for cookie in &cookies {
        let pending = Arc::clone(&pending);
        let completion: RcBlock<dyn Fn()> = RcBlock::new(move || pending.record_commit());
        // SAFETY: `cookie` outlives the call (WebKit copies it), and the block
        // is retained by the runtime for as long as the completion is pending.
        #[allow(unsafe_code)]
        unsafe {
            store.setCookie_completionHandler(cookie, Some(&completion))
        };
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
fn log_default_store_names(domain: String, mtm: MainThreadMarker) {
    let store = default_cookie_store(mtm);
    let completion: RcBlock<dyn Fn(std::ptr::NonNull<NSArray<NSHTTPCookie>>)> =
        RcBlock::new(move |cookies: std::ptr::NonNull<NSArray<NSHTTPCookie>>| {
            // SAFETY: WebKit hands the block a live array it owns for the
            // duration of the call; we only read from it here.
            #[allow(unsafe_code)]
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
    #[allow(unsafe_code)]
    unsafe {
        store.getAllCookies(&completion)
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Drive a [`PendingWrites`] the way WebKit drives the real completion
    /// blocks: build one caller per expected write, then fire them in
    /// `fire_order`. Returns how many times the continuation ran.
    fn run_completions(count: usize, fire_order: &[usize]) -> usize {
        let runs = Arc::new(AtomicUsize::new(0));
        let runs_in_continuation = Arc::clone(&runs);
        let pending = PendingWrites::new(count, move || {
            runs_in_continuation.fetch_add(1, Ordering::SeqCst);
        });
        // One `Fn` closure per write, each holding its own handle — the shape
        // `seed_default_store_then` hands to `RcBlock::new`.
        let completions: Vec<Box<dyn Fn()>> = (0..count)
            .map(|_| {
                let pending = Arc::clone(&pending);
                Box::new(move || pending.record_commit()) as Box<dyn Fn()>
            })
            .collect();
        for &index in fire_order {
            completions[index]();
        }
        runs.load(Ordering::SeqCst)
    }

    /// The continuation runs exactly once, on the last completion — whatever
    /// order WebKit delivers them in. Ordering is not ours to choose: the
    /// completions are independent main-loop callbacks.
    #[test]
    fn pending_writes_runs_the_continuation_once_after_the_last_commit() {
        assert_eq!(run_completions(3, &[0, 1, 2]), 1);
        assert_eq!(run_completions(3, &[2, 0, 1]), 1, "order must not matter");
        assert_eq!(run_completions(1, &[0]), 1);
    }

    /// A partially-committed batch must NOT navigate: that is the bug the
    /// counting prevents — the target's first request would race the cookies
    /// still in flight and arrive unauthenticated.
    #[test]
    fn pending_writes_holds_the_continuation_until_every_write_commits() {
        assert_eq!(run_completions(3, &[0]), 0);
        assert_eq!(run_completions(3, &[0, 1]), 0);
    }

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
        #[allow(unsafe_code)]
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
        #[allow(unsafe_code)]
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
