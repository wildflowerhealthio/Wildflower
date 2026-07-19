//! Desktop backend. Mirrors the iOS/Android layout via Tauri's
//! multi-webview-per-window API (`Window::add_child`, `unstable` feature): a
//! chrome bar (title / subtitle / message + back / forward / refresh) anchored
//! at the top and the external content webview below, sharing one parent
//! `Window`. Unlike mobile, desktop is **multi-instance**: one such window (plus
//! its per-id state in [`PluginState`]) exists per caller-named instance id, so
//! e.g. a background sniffer scrape and a launched app run concurrently without
//! colliding — every function here is keyed by `id`. The cross-platform
//! lifecycle/race protocols this implements live in
//! [docs/Lifecycle and Races Explanation.md](../docs/Lifecycle%20and%20Races%20Explanation.md); the
//! higher-level "what / why" in [docs/Explanation.md](../docs/Explanation.md).
//!
//! ## Chrome ↔ Rust IPC
//!
//! The chrome webview loads its DOM from a base64 `data:text/html` URL (the
//! [`CHROME_HTML_TEMPLATE`] document, see [`build_chrome_data_url`]).
//! Communication needs no `__TAURI__` event bus access on either side:
//!
//! - **Chrome → Rust**: button clicks + height reports `fetch` a
//!   [`CHROME_ACTION_SCHEME`] URL; the URI-scheme handler installed by
//!   [`register_chrome_action_scheme`] dispatches the matching `eval` onto the
//!   content webview (or resizes the chrome). A subresource fetch never enters
//!   WebKit's navigation-policy path, so — unlike the earlier cancelled-nav
//!   trick — it emits no policy-`ignore` backtrace; and being a webview resource
//!   loader rather than an IPC command, it needs no capability grant. The
//!   handler guards on the requesting webview label so only the chrome can drive
//!   these actions.
//! - **Rust → Chrome**: `webview.eval(...)` (e.g. [`WINDOW_TEXT_FN`]) — Rust-
//!   initiated, so it bypasses capability checks and the chrome's `data:` origin
//!   needs no capability entry.
//!
//! Caveat vs. mobile: both webviews are Tauri webviews here, so the content one
//! still has `window.__TAURI__`; the host app's capability JSON scopes it to
//! event-bus listen plus the gated `native_webview_data_plane_emit` command (no
//! bus `emit`, no log) — see `capabilities/native-webview-window.json`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::de::DeserializeOwned;
use tauri::{
    ipc::Channel,
    plugin::{Builder as PluginBuilder, PluginApi},
    webview::WebviewBuilder,
    window::WindowBuilder,
    AppHandle, LogicalPosition, LogicalSize, Manager, Runtime, WebviewUrl, WindowEvent,
};
use url::Url;

use crate::models::{
    CookieSameSite, CookieSpec, EvaluateJsRequest, NativeWebviewEvent, OpenRequest,
    PatchWindowTextRequest,
};

/// Label prefix shared by every native-webview instance's window + child
/// webviews. A caller-named instance id is appended: `native-webview-<id>` for
/// the window, `-<id>-chrome` / `-<id>-content` for the children (see
/// [`window_label`] / [`chrome_label`] / [`content_label`]).
/// `capabilities/native-webview-window.json` globs on `native-webview-*` to
/// scope the grant across all instances.
const LABEL_PREFIX_DASH: &str = "native-webview-";

/// Parent-window label for instance `id`.
fn window_label(id: &str) -> String {
    format!("{LABEL_PREFIX_DASH}{id}")
}
/// Chrome (top bar) child-webview label for instance `id`.
fn chrome_label(id: &str) -> String {
    format!("{LABEL_PREFIX_DASH}{id}-chrome")
}
/// Content (external URL) child-webview label for instance `id`.
fn content_label(id: &str) -> String {
    format!("{LABEL_PREFIX_DASH}{id}-content")
}
/// Recover the instance id from a chrome webview's label — the inverse of
/// [`chrome_label`]. The action-scheme handler is app-global, so it derives the
/// requesting instance from `ctx.webview_label()` (only the chrome webview ever
/// issues these fetches). Strips exactly one `-chrome` suffix, so an id that
/// itself contains `-chrome` round-trips.
fn id_from_chrome_label(label: &str) -> Option<&str> {
    label
        .strip_prefix(LABEL_PREFIX_DASH)
        .and_then(|rest| rest.strip_suffix("-chrome"))
}

/// Teardown backstop — see docs/Lifecycle and Races Explanation.md § "Teardown backstops"
/// (desktop's absolute-lifetime cap; re-armed per `open_url` via
/// [`arm_absolute_timeout`], superseded via [`InstanceState::timeout_generation`]).
const ABSOLUTE_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// Logical-px chrome bar height in its compact state (title + nav buttons, no
/// subtitle), with a sliver above the ~50px nav-button floor. The expanded
/// "title + subtitle" height lives in the chrome JS, which owns the visibility
/// check and reports its height back via `x-nv-action://height/<n>` — Rust
/// treats that value as opaque.
const CHROME_HEIGHT_BASE: f64 = 52.0;

/// Custom URI scheme the chrome bar `fetch`es to signal Rust; handled by
/// [`register_chrome_action_scheme`], which returns an empty 200. URL shapes:
/// - `x-nv-action://action/<back|forward|refresh>` — button click; Rust
///   dispatches the matching history call on the content webview.
/// - `x-nv-action://height/<logical_px>` — chrome reports its desired height;
///   Rust resizes the chrome + content webviews to match.
const CHROME_ACTION_SCHEME: &str = "x-nv-action";

/// Rust → chrome state push: this global is defined by the chrome's init
/// script and invoked from Rust via `webview.eval(...)`.
const WINDOW_TEXT_FN: &str = "window.__nativeWebviewPatchWindowText";

/// Rust → chrome nav-state push for back/forward button enabled state.
/// Tracked Rust-side because Tauri's `Webview` exposes no `can_go_back` /
/// `can_go_forward` predicates — see [`InstanceState`]'s `nav_*` fields for the
/// approximation.
const CHROME_NAV_STATE_FN: &str = "window.__nativeWebviewSetNavState";

/// Rust → chrome URL push, invoked from `on_page_load` (Started) to keep the
/// URL-fallback in sync with navigation — see docs/Lifecycle and Races Explanation.md
/// § "Chrome URL-fallback".
const CHROME_SET_URL_FN: &str = "window.__nativeWebviewSetUrl";

/// Rust → chrome reset push for an in-place re-open (see [`apply_rewire`] and
/// docs/Lifecycle and Races Explanation.md § "Re-open rewire"): clears the chrome's claim
/// state + slots, seeds the new URL, re-applies the caller's initial chrome.
const CHROME_RESET_TEXT_FN: &str = "window.__nativeWebviewResetWindowText";

/// Full HTML document the chrome webview loads as its source, kept as a
/// standalone [`chrome.html`](./chrome.html) so it edits as HTML rather than a
/// Rust string literal. Base64-encoded into a `data:` URL at runtime (see
/// [`build_chrome_data_url`]); its [`CHROME_STATE_PLACEHOLDER`] is substituted
/// with the seed state so the bar is correct on first paint with no
/// `about:blank` + init-script race.
const CHROME_HTML_TEMPLATE: &str = include_str!("chrome.html");

/// The `__INITIAL_STATE__` placeholder in [`CHROME_HTML_TEMPLATE`], replaced at
/// runtime with the JSON the chrome's inline script seeds itself from.
const CHROME_STATE_PLACEHOLDER: &str = "__INITIAL_STATE__";

/// Seed state for the chrome's URL-fallback (see docs/Lifecycle and Races Explanation.md
/// § "Chrome URL-fallback"), serialised to JSON and substituted into
/// [`CHROME_STATE_PLACEHOLDER`]. Site-specific: a `None` slot serialises to JSON
/// `null` = "caller hasn't claimed this slot".
#[derive(serde::Serialize)]
struct InitialChromeState<'a> {
    url: &'a str,
    title: Option<&'a str>,
    subtitle: Option<&'a str>,
    message: Option<&'a str>,
}

/// Build the chrome webview's source URL — [`CHROME_HTML_TEMPLATE`] with the
/// initial-state JSON substituted in, base64-encoded into a
/// `data:text/html;base64,…` URL.
///
/// Caller values need no HTML-escaping (the chrome assigns them via
/// `textContent`, never `innerHTML`); the one escape that matters is `<` in the
/// JSON, replaced with its `<` unicode escape so a value containing
/// `</script>` can't break out of the inline `<script>` (see the
/// `build_chrome_data_url_escapes_script_breakout` test). Errors surface through `crate::Result`
/// rather than `.expect` so a future template change that produces an invalid
/// URL fails the `open` cleanly instead of panicking.
fn build_chrome_data_url(state: &InitialChromeState) -> crate::Result<Url> {
    const SCRIPT_BREAKOUT_ESCAPE: &str = "\\u003c";
    let json = serde_json::to_string(state)
        .map_err(|error| crate::Error::Internal(error.to_string()))?
        .replace('<', SCRIPT_BREAKOUT_ESCAPE);
    let html = CHROME_HTML_TEMPLATE.replace(CHROME_STATE_PLACEHOLDER, &json);
    let encoded = BASE64.encode(html.as_bytes());
    Url::parse(&format!("data:text/html;base64,{encoded}"))
        .map_err(|error| crate::Error::Internal(error.to_string()))
}

/// Convert a wire [`CookieSpec`] into the typed [`tauri::webview::cookie`]
/// `Cookie` handed to `Webview::set_cookie`. Pure field mapping — attribute
/// grammar stays the vetted cookie crate's.
fn cookie_from_spec(spec: &CookieSpec) -> tauri::webview::cookie::Cookie<'static> {
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
fn seed_cookies<R: Runtime>(
    content: &tauri::webview::Webview<R>,
    cookies: &[CookieSpec],
) -> crate::Result<()> {
    for spec in cookies {
        content.set_cookie(cookie_from_spec(spec))?;
    }
    Ok(())
}

/// The transient `about:blank` a cookie-seeding open builds at before
/// navigating to the real target (see [`present`]).
fn blank_url() -> crate::Result<Url> {
    Url::parse("about:blank").map_err(|error| crate::Error::Internal(error.to_string()))
}

/// Build the desktop backend.
pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<NativeWebview<R>> {
    app.manage(PluginState {
        instances: Mutex::new(HashMap::new()),
    });
    Ok(NativeWebview(app.clone()))
}

/// App-managed registry of every live native-webview instance, keyed by the
/// caller-named instance id (see [`window_label`]). Each instance is fully
/// isolated so, e.g., a background sniffer scrape and a launched app can run
/// concurrently in separate windows without trampling each other's chrome
/// height, nav history, event channel, or dispose→open race state — the reason
/// this replaced the earlier single-shared-window model.
struct PluginState {
    /// Instance state by id. An entry is created (or reset) on a fresh
    /// [`present`] build and left in place across dispose/reopen — ids are a
    /// small fixed set (`sniffer`, `launch`), so the map never grows unbounded
    /// and keeping entries preserves the backstop thread's condvar identity.
    instances: Mutex<HashMap<String, Arc<InstanceState>>>,
}

/// Per-instance coordination + chrome/nav state — everything that was, in the
/// single-window design, either an app-global singleton or a type-keyed
/// `window.manage` cell (which is app-global too; see the note on
/// [`install_instance_state`]). One of these lives per instance id in
/// [`PluginState::instances`].
///
/// Site-specific: `WebviewWindow::close()` only *queues* a `WindowMessage::Close`
/// via the runtime proxy (`runtime-wry/lib.rs::WindowDispatcher::close`) and
/// returns immediately, which is why the same-tick `present()` runs before
/// `CloseRequested` and the [`Self::pending_reopen`] deferral is needed.
struct InstanceState {
    /// Chrome bar's current logical-px height. Read by the resize listener (so a
    /// window resize keeps the right vertical split), written by the chrome →
    /// Rust height-report fetch.
    chrome_height: Mutex<f64>,
    /// Last `(logical_w, logical_h, chrome_height)` actually applied to **both**
    /// child webviews, so [`apply_chrome_height`] can short-circuit a no-op
    /// relayout. Recorded only once both children were present and laid out.
    applied_layout: Mutex<Option<(f64, f64, f64)>>,
    /// The [`Channel<NativeWebviewEvent>`] this instance's events fire on;
    /// re-bound by [`apply_rewire`] so a second `open` routes subsequent events
    /// (dismissal `Hidden`, teardown `Disposed`) to the latest caller.
    current_channel: Mutex<Channel<NativeWebviewEvent>>,
    /// Content nav-history approximation (Tauri exposes no `can_go_back`):
    /// `load_count` ++ on every content Started load, `canBack` = `> 1`. Reset to
    /// 0 only on a fresh build — a reopen navigating the same content webview
    /// keeps it, so Back stays enabled once ≥2 pages loaded.
    nav_load_count: Mutex<u32>,
    /// `true` once the chrome Back button fires (fresh-nav truncates the forward
    /// stack, so [`apply_rewire`] clears it); left sticky otherwise.
    nav_can_forward: AtomicBool,
    /// The `disposing` flag: `true` between `dispose()` and the following
    /// `Destroyed`. Read by `present()` to take the deferral branch.
    disposing: AtomicBool,
    /// The deferred replay (`present()` request + its already-parsed [`Url`], so
    /// the `CloseRequested` replay doesn't re-parse). The handler `Option::take`s
    /// it: `Some` → cancel the dispose and replay; `None` → dispose proceeds.
    pending_reopen: Mutex<Option<(OpenRequest, Url)>>,
    /// Generation counter for the [`ABSOLUTE_TIMEOUT`] backstop (see
    /// [`arm_absolute_timeout`]).
    timeout_generation: AtomicU64,
    /// Condvar mutex paired with [`Self::timeout_changed`]. Held only for the
    /// brief predicate re-check inside the backstop thread's timed wait; carries
    /// no data (the generation lives in the atomic).
    timeout_wait: Mutex<()>,
    /// Notified whenever [`Self::timeout_generation`] advances (a re-arm or a
    /// teardown) so a parked backstop thread wakes the instant it's superseded
    /// instead of lingering until [`ABSOLUTE_TIMEOUT`] — keeps ≤1 thread parked.
    /// See [`arm_absolute_timeout`].
    timeout_changed: Condvar,
}

impl InstanceState {
    /// A fresh instance's state (nav history at 0, not disposing, no pending
    /// replay), bound to `channel`.
    fn new(channel: Channel<NativeWebviewEvent>) -> Self {
        Self {
            chrome_height: Mutex::new(CHROME_HEIGHT_BASE),
            applied_layout: Mutex::new(None),
            current_channel: Mutex::new(channel),
            nav_load_count: Mutex::new(0),
            nav_can_forward: AtomicBool::new(false),
            disposing: AtomicBool::new(false),
            pending_reopen: Mutex::new(None),
            timeout_generation: AtomicU64::new(0),
            timeout_wait: Mutex::new(()),
            timeout_changed: Condvar::new(),
        }
    }
}

/// Clone-out the [`InstanceState`] for `id`, or `None` if no such instance is
/// registered. Returns an `Arc` so callers work without holding the map lock.
fn instance_state<R: Runtime>(app: &AppHandle<R>, id: &str) -> Option<Arc<InstanceState>> {
    let state = app.try_state::<PluginState>()?;
    let map = state.instances.lock().ok()?;
    map.get(id).cloned()
}

/// Desktop handle to the native-webview plugin.
pub struct NativeWebview<R: Runtime>(AppHandle<R>);

impl<R: Runtime> NativeWebview<R> {
    /// Build (if absent) and navigate the native webview to `url` without
    /// presenting it — see docs/Lifecycle and Races Explanation.md § "Visibility, liveness,
    /// and existence are independent". Window creation is marshalled onto the
    /// main thread (required on macOS); the result returns via a `sync_channel`.
    ///
    /// No deadlock: `run_on_main_thread` is synchronous when *called from* the
    /// main thread (`send_user_message` runs `handle_user_message` inline on a
    /// thread match), so a main-thread caller's `tx.send` has already fired by
    /// `rx.recv()`. Off-main-thread callers block on the main thread draining the
    /// queue — safe, no self-wait.
    ///
    /// A cookie-carrying request (see [`OpenRequest`]'s `cookies`) MUST be sent
    /// from OFF the main thread: the webview builds at `about:blank`, then this
    /// caller thread queues the cookie writes + the real-target navigation onto the
    /// main loop (FIFO). See [`seed_cookies`] for why the main thread deadlocks.
    pub fn open_url(&self, id: &str, mut payload: OpenRequest) -> crate::Result<()> {
        // Parse once (http(s)-only — see [`crate::url_scheme`]) and thread the
        // parsed `Url` to `present` so the build path doesn't re-parse.
        let target = crate::url_scheme::parse_http_url(&payload.url)?;
        // Cookies are seeded from THIS thread after the build, never inside
        // `present()` — see the method doc.
        let cookies = std::mem::take(&mut payload.cookies);
        let build_url = if cookies.is_empty() {
            target.clone()
        } else {
            blank_url()?
        };
        let app = self.0.clone();
        let (tx, rx) = std::sync::mpsc::sync_channel::<crate::Result<()>>(1);
        let present_target = target.clone();
        let present_id = id.to_owned();
        self.0.run_on_main_thread(move || {
            // Best-effort: rx is dropped only when the caller already exited.
            let _ = tx.send(present(
                &app,
                &present_id,
                payload,
                present_target,
                build_url,
            ));
        })?;
        rx.recv()
            .map_err(|error| crate::Error::Internal(error.to_string()))??;
        if !cookies.is_empty() {
            let content = self.0.get_webview(&content_label(id)).ok_or_else(|| {
                crate::Error::Internal(
                    "native-webview content webview missing after a cookie-seeding open".to_owned(),
                )
            })?;
            seed_cookies(&content, &cookies)?;
            content.navigate(target)?;
        }
        Ok(())
    }

    /// Cookie **names** currently visible to instance `id`'s content webview for
    /// `url` — a read-back for verifying the pre-navigation cookie seeding (see
    /// [`OpenRequest`]'s `cookies`). Names only, never values: the point is
    /// observability ("did `wf_auth` land?"), not exfiltrating the jar.
    /// `Ok(None)` when no content webview is open. Desktop-only (mobile has no
    /// equivalent surface; wry's Android cookie read is a stub anyway).
    pub fn content_cookie_names_for_url(
        &self,
        id: &str,
        url: Url,
    ) -> crate::Result<Option<Vec<String>>> {
        let Some(content) = self.0.get_webview(&content_label(id)) else {
            return Ok(None);
        };
        let cookies = content.cookies_for_url(url)?;
        Ok(Some(
            cookies
                .iter()
                .map(|cookie| cookie.name().to_owned())
                .collect(),
        ))
    }

    /// Evaluate JS in the content webview. Returns an error if no native webview is
    /// open (matches the mobile contract — `evaluate_js` is content-bound, so
    /// there's no graceful fallback).
    pub fn evaluate_js(&self, id: &str, payload: EvaluateJsRequest) -> crate::Result<()> {
        let content = self
            .0
            .get_webview(&content_label(id))
            .ok_or_else(|| crate::Error::Internal("no native-webview open".to_owned()))?;
        content.eval(&payload.script)?;
        Ok(())
    }

    /// Push title / subtitle / message into the chrome by `eval`-ing the
    /// init-script-defined `__nativeWebviewPatchWindowText` global with a JSON
    /// payload of only the fields the caller wants to change. The JS side
    /// applies non-`null` fields and leaves the rest untouched — matching
    /// the iOS / Android `patchWindowText` semantics.
    ///
    /// No-op if no native webview is open. Returns `Ok` either way so callers can
    /// fire speculatively across the native webview lifecycle (mirrors mobile
    /// `{set: false}` on a closed native webview).
    pub fn patch_window_text(
        &self,
        id: &str,
        payload: PatchWindowTextRequest,
    ) -> crate::Result<()> {
        let Some(chrome) = self.0.get_webview(&chrome_label(id)) else {
            return Ok(());
        };
        // The wire camelCase keys match what `__nativeWebviewPatchWindowText` reads.
        let json = serde_json::to_string(&payload)
            .map_err(|error| crate::Error::Internal(error.to_string()))?;
        chrome.eval(format!("{WINDOW_TEXT_FN}({json})"))?;
        Ok(())
    }

    /// Present the native webview window (built hidden by [`open_url`]) — see
    /// docs/Lifecycle and Races Explanation.md § "Visibility, liveness, and existence are
    /// independent". Reveals immediately; a `show()` before the content's first
    /// paint may briefly flash the window background on macOS dark mode —
    /// accepted. Idempotent — no-op if no window exists.
    pub fn show(&self, id: &str) -> crate::Result<()> {
        if let Some(window) = self.0.get_window(&window_label(id)) {
            window.show()?;
            let _ = window.set_focus();
        }
        Ok(())
    }

    /// Hide the window but keep it (and its child webviews) alive and running —
    /// see docs/Lifecycle and Races Explanation.md § "User dismissal hides; only `dispose`
    /// tears down". Emits [`NativeWebviewEvent::Hidden`]. Idempotent — no-op if
    /// no window exists.
    ///
    /// Site-specific: `window.hide()` fires no `CloseRequested`/`Destroyed`, so
    /// nothing is torn down (and `Hidden` must be emitted directly here — there
    /// is no `Destroyed` for the window listener to translate).
    pub fn hide(&self, id: &str) -> crate::Result<()> {
        let Some(window) = self.0.get_window(&window_label(id)) else {
            return Ok(());
        };
        window.hide()?;
        if let Some(instance) = instance_state(&self.0, id) {
            if let Ok(channel) = instance.current_channel.lock() {
                let _ = channel.send(NativeWebviewEvent::Hidden);
            }
        }
        Ok(())
    }

    /// Dispose the native webview window — tear it down and free its resources;
    /// the `Destroyed` handler emits [`NativeWebviewEvent::Disposed`]. Flips
    /// [`PluginState::disposing`] before closing so a racing same-tick
    /// `open_url()` defers — see [`PluginState`] and docs/Lifecycle and Races Explanation.md
    /// § "The dispose→open \"switch-demo\" race". Idempotent — no-op if no window.
    pub fn dispose(&self, id: &str) -> crate::Result<()> {
        let Some(window) = self.0.get_window(&window_label(id)) else {
            return Ok(());
        };
        if let Some(instance) = instance_state(&self.0, id) {
            instance.disposing.store(true, Ordering::SeqCst);
        }
        window.close()?;
        Ok(())
    }
}

/// Arm (or re-arm) instance `id`'s [`ABSOLUTE_TIMEOUT`] backstop — see
/// docs/Lifecycle and Races Explanation.md § "Teardown backstops". Bumps that
/// instance's [`InstanceState::timeout_generation`] (superseding any prior
/// timer), wakes the prior generation's parked thread so it exits immediately,
/// and spawns a parked thread (no async runtime dependency; ≤1 live per instance
/// across rapid reopens, since each re-arm releases the last) that disposes on
/// fire iff its captured generation is still current. On fire it mirrors a host
/// `dispose()` (set `disposing`, `window.close()`). The thread holds an
/// `Arc<InstanceState>` so its condvar stays valid even though the instance map
/// is looked up by id elsewhere.
fn arm_absolute_timeout<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let Some(instance) = instance_state(app, id) else {
        return;
    };
    let generation = instance.timeout_generation.fetch_add(1, Ordering::SeqCst) + 1;
    // Release any prior generation's parked thread now that it's superseded.
    instance.timeout_changed.notify_all();
    let app = app.clone();
    let id = id.to_owned();
    std::thread::spawn(move || {
        // Park until ABSOLUTE_TIMEOUT elapses OR this generation is superseded
        // (a re-arm or teardown bumps the generation and notifies). A poisoned
        // condvar mutex just drops the backstop — teardown handles itself.
        let Ok(guard) = instance.timeout_wait.lock() else {
            return;
        };
        let Ok((_guard, wait)) =
            instance
                .timeout_changed
                .wait_timeout_while(guard, ABSOLUTE_TIMEOUT, |()| {
                    instance.timeout_generation.load(Ordering::SeqCst) == generation
                })
        else {
            return;
        };
        // Superseded before the timeout → this generation is stale, exit.
        if !wait.timed_out() {
            return;
        }
        // Release the condvar guard (which borrows `instance`) before handing a
        // fresh `Arc` clone to the main-thread closure.
        drop(_guard);
        let handle = app.clone();
        let instance = instance.clone();
        // Window ops are main-thread on macOS. A failed marshal (app shutting
        // down) just drops the backstop — teardown is happening anyway.
        let _ = app.run_on_main_thread(move || {
            // Stale (a reopen/teardown advanced the generation between the wait
            // returning and this marshal) → no-op.
            if instance.timeout_generation.load(Ordering::SeqCst) != generation {
                return;
            }
            let Some(window) = handle.get_window(&window_label(&id)) else {
                return;
            };
            instance.disposing.store(true, Ordering::SeqCst);
            let _ = window.close();
        });
    });
}

/// Build or re-target the native webview. Three branches:
/// - **Disposing in flight**: defer into [`PluginState::pending_reopen`] for the
///   `CloseRequested` handler to replay — see docs/Lifecycle and Races Explanation.md
///   § "The dispose→open \"switch-demo\" race".
/// - **Already open**: replay onto the existing webviews via [`apply_rewire`] —
///   see docs/Lifecycle and Races Explanation.md § "Re-open rewire".
/// - **Fresh build**: construct the parent window, chrome + content child
///   webviews, and install the resize / close / destroy listeners.
///
/// `target_url` is what the caller asked to open (chrome display, OS title,
/// deferred replay); `build_url` is what the fresh build / rewire actually
/// navigates to — identical except on a cookie-seeding open, where the build
/// parks at `about:blank` and [`NativeWebview::open_url`] navigates to the
/// target from the caller thread once the queued cookie writes commit.
fn present<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    payload: OpenRequest,
    target_url: Url,
    build_url: Url,
) -> crate::Result<()> {
    // Dispose in flight (for THIS instance): defer the replay (last-write-wins on
    // a rapid double-`open`). See [`InstanceState`]. The replay stores the TARGET:
    // by the time it runs, the caller thread's cookie writes are queued/committed,
    // so navigating straight to the target is correct (and parking on
    // `about:blank` would strand the popup — nobody re-navigates a replay).
    if let Some(instance) = instance_state(app, id) {
        if instance.disposing.load(Ordering::SeqCst) {
            *lock_state(&instance.pending_reopen, "pending-reopen")? = Some((payload, target_url));
            return Ok(());
        }
    }

    // Already open: rewire this instance in place rather than rebuild.
    if let Some(content) = app.get_webview(&content_label(id)) {
        apply_rewire(app, id, &content, &payload, target_url, build_url)?;
        return Ok(());
    }

    let init_script = payload.init_script;
    let channel = payload.native_webview_event_channel;
    let initial_url = target_url.as_str().to_owned();

    // OS-level title (taskbar / title bar) is the caller's initial title, else
    // the content URL — never a hard-coded app name.
    let window_title = payload
        .initial_title
        .as_ref()
        .unwrap_or(&initial_url)
        .clone();
    // Built hidden; presented only by an explicit `show()` (see [`open_url`]).
    let window = WindowBuilder::new(app, window_label(id))
        .title(window_title)
        .inner_size(900.0, 700.0)
        .resizable(true)
        .visible(false)
        .build()?;

    let window_size = window.inner_size()?;
    let scale = window.scale_factor()?;
    let logical_width = window_size.width as f64 / scale;
    let logical_height = window_size.height as f64 / scale;

    // Must precede `add_child` so the chrome's first height report (on
    // DOMContentLoaded) and the resize listener find the instance state present.
    install_instance_state(app, id, channel);

    // Chrome webview. The initial state is baked into the `data:` HTML (vs a
    // post-open patch) so the bar is correct on first paint — see the Lifecycle
    // & Races doc § "Chrome URL-fallback". The chrome bar's button clicks +
    // height reports arrive as `fetch`es of the [`CHROME_ACTION_SCHEME`] URI
    // scheme, dispatched by the handler `register_chrome_action_scheme` installs
    // on the plugin builder — no navigation, so no WebKit policy-`ignore`
    // backtrace, and no `__TAURI__` grant needed on this `data:` origin.
    let chrome_url = build_chrome_data_url(&InitialChromeState {
        url: &initial_url,
        title: payload.initial_title.as_deref(),
        subtitle: payload.initial_subtitle.as_deref(),
        message: payload.initial_message.as_deref(),
    })?;
    let chrome_builder = WebviewBuilder::new(chrome_label(id), WebviewUrl::External(chrome_url));
    window.add_child(
        chrome_builder,
        LogicalPosition::<f64>::new(0.0, 0.0),
        LogicalSize::<f64>::new(logical_width, CHROME_HEIGHT_BASE),
    )?;

    // Content webview: built at `build_url` — the external target, except on a
    // cookie-seeding open, where it parks at `about:blank` until the caller
    // thread's queued cookie writes commit (see [`NativeWebview::open_url`]).
    let mut content_builder =
        WebviewBuilder::new(content_label(id), WebviewUrl::External(build_url));
    if let Some(script) = init_script {
        content_builder = content_builder.initialization_script(script);
    }
    // Sync the chrome URL fallback (see docs/Lifecycle and Races Explanation.md § "Chrome
    // URL-fallback") + back/forward state on each page load. `Started` (not
    // `Finished`) so it lands as the navigation commits. See [`InstanceState`].
    let app_for_loads = app.clone();
    let id_for_loads = id.to_owned();
    content_builder = content_builder.on_page_load(move |_webview, payload| {
        if !matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
            return;
        }
        // A cookie-seeding open transits `about:blank` before the real target;
        // that transient load must neither flash in the chrome URL bar nor
        // count as a history entry for the Back-button approximation.
        if payload.url().as_str() == "about:blank" {
            return;
        }
        // URL-fallback sync, kept independent of the nav-button bookkeeping below
        // so it still fires if the instance state is somehow absent.
        if let Some(chrome) = app_for_loads.get_webview(&chrome_label(&id_for_loads)) {
            if let Ok(arg) = serde_json::to_string(payload.url().as_str()) {
                let _ = chrome.eval(format!("{CHROME_SET_URL_FN}({arg})"));
            }
        }
        let Some(instance) = instance_state(&app_for_loads, &id_for_loads) else {
            return;
        };
        let new_count = {
            // Best-effort in a page-load callback: skip the nav-state update on
            // a poisoned lock rather than panicking.
            let Ok(mut count) = instance.nav_load_count.lock() else {
                return;
            };
            *count = count.saturating_add(1);
            *count
        };
        let can_back = new_count > 1;
        let can_forward = instance.nav_can_forward.load(Ordering::SeqCst);
        if let Some(chrome) = app_for_loads.get_webview(&chrome_label(&id_for_loads)) {
            let _ = chrome.eval(format!(
                "{CHROME_NAV_STATE_FN}({{canBack:{can_back},canForward:{can_forward}}})"
            ));
        }
    });
    window.add_child(
        content_builder,
        LogicalPosition::<f64>::new(0.0, CHROME_HEIGHT_BASE),
        LogicalSize::<f64>::new(
            logical_width,
            (logical_height - CHROME_HEIGHT_BASE).max(0.0),
        ),
    )?;

    install_window_listeners(app, id, &window);
    arm_absolute_timeout(app, id);

    Ok(())
}

/// Lock a native-webview-state mutex, mapping a poisoned lock to a surfaced
/// [`crate::Error`] instead of an `unwrap` panic, so the `open` / `present` path
/// fails cleanly rather than taking the process down. (These critical sections
/// are trivial assignments that never panic, so poisoning isn't expected.)
/// Error-channel-less event handlers (resize / close / destroy) instead skip the
/// update on a poisoned lock — see their call sites.
fn lock_state<'a, T>(
    mutex: &'a Mutex<T>,
    what: &str,
) -> crate::Result<std::sync::MutexGuard<'a, T>> {
    mutex
        .lock()
        .map_err(|_| crate::Error::Internal(format!("native-webview {what} state lock poisoned")))
}

/// Insert (or reset) instance `id`'s [`InstanceState`] in [`PluginState`],
/// bound to `channel`. Called on every fresh [`present`] build before the
/// children are added so the chrome's first height report and the resize
/// listener find the state present.
///
/// Site-specific (not in the cross-platform doc): the earlier single-window
/// design stashed this in type-keyed `window.manage` cells, but `window.manage`
/// writes APP-GLOBAL state (a `Window`'s manager is the shared `AppManager`, not
/// a per-window map), so it can't hold distinct values for concurrent instances.
/// The per-id map here is what makes multiple live instances possible. Entries
/// are kept across dispose/reopen (ids are a small fixed set), so a fresh build
/// overwrites any prior entry for the same id — equivalent to the old reset.
fn install_instance_state<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    channel: Channel<NativeWebviewEvent>,
) {
    let Some(state) = app.try_state::<PluginState>() else {
        return;
    };
    let Ok(mut map) = state.instances.lock() else {
        return;
    };
    map.insert(id.to_owned(), Arc::new(InstanceState::new(channel)));
}

/// Replay an `open` request onto the existing chrome + content webviews
/// (rebind channel, re-eval init script, re-apply initial chrome, navigate) —
/// see docs/Lifecycle and Races Explanation.md § "Re-open rewire". The init script lands via
/// `eval` (not document-start: Tauri has no API to swap that hook post-build);
/// harmless here since the sniffer's script is stable across opens.
///
/// `target` feeds the chrome display; `navigate_to` is what actually loads —
/// identical except on a cookie-seeding open (see [`present`]'s doc), where
/// this parks the content at `about:blank` and the caller thread navigates to
/// the target after the queued cookie writes. The `CloseRequested` replay
/// passes the target for both (cookies are already committed by then).
fn apply_rewire<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    content: &tauri::webview::Webview<R>,
    payload: &OpenRequest,
    target: Url,
    navigate_to: Url,
) -> crate::Result<()> {
    if let Some(instance) = instance_state(app, id) {
        *lock_state(&instance.current_channel, "current-channel")? =
            payload.native_webview_event_channel.clone();
        // Same content webview → keep `nav_load_count` (Back stays enabled); only
        // clear `nav_can_forward` (fresh nav truncates the forward stack). See
        // [`InstanceState`].
        instance.nav_can_forward.store(false, Ordering::SeqCst);
    }
    if let Some(script) = &payload.init_script {
        let _ = content.eval(script);
    }
    if let Some(chrome) = app.get_webview(&chrome_label(id)) {
        // A rewire is logically a fresh open: reset the chrome's URL-fallback
        // claims + slots and seed the new URL (don't merge onto prior claims).
        let reset = InitialChromeState {
            url: target.as_str(),
            title: payload.initial_title.as_deref(),
            subtitle: payload.initial_subtitle.as_deref(),
            message: payload.initial_message.as_deref(),
        };
        if let Ok(json) = serde_json::to_string(&reset) {
            let _ = chrome.eval(format!("{CHROME_RESET_TEXT_FN}({json})"));
        }
    }
    // Blank the previous page before the navigation: a reused content webview
    // otherwise keeps showing the prior app until the new target's first
    // paint. Queued ahead of `navigate` on the same FIFO loop, so the clear
    // always lands first.
    let _ = content.eval("document.documentElement.innerHTML = ''");
    let _ = content.navigate(navigate_to);
    // A reopen starts a new task clock — re-arm the backstop.
    arm_absolute_timeout(app, id);
    Ok(())
}

/// Register the chrome bar's [`CHROME_ACTION_SCHEME`] (`x-nv-action://`) URI
/// scheme on the plugin builder. The chrome `data:` document signals Rust by
/// `fetch`-ing these URLs (button clicks + height reports); the handler
/// dispatches the action onto the content webview or resizes the chrome. Using a
/// fetched custom scheme rather than a cancelled top-level navigation keeps
/// WebKit from logging a policy-`ignore` backtrace on every signal, and — being
/// a webview resource loader, not an IPC command — keeps the chrome
/// capability-free (no `__TAURI__`). See the module docs § "Chrome ↔ Rust IPC".
pub(crate) fn register_chrome_action_scheme<R: Runtime>(
    builder: PluginBuilder<R>,
) -> PluginBuilder<R> {
    builder.register_uri_scheme_protocol(CHROME_ACTION_SCHEME, |ctx, request| {
        // The handler is app-global (one registration serves every instance), so
        // any webview — including an untrusted content page — can reach it. Only
        // a *chrome* webview may drive these actions: a hostile content page
        // fetching a bogus `height` could otherwise distort its instance's chrome
        // layout. (back/forward/refresh grant it nothing it can't already do to
        // itself.) The requesting chrome label also names the instance to act on.
        if let Some(id) = id_from_chrome_label(ctx.webview_label()) {
            if let Ok(url) = Url::parse(&request.uri().to_string()) {
                dispatch_chrome_action(ctx.app_handle(), id, &url);
            }
        }
        empty_scheme_response()
    })
}

/// Dispatch one `x-nv-action://<kind>/<value>` signal from instance `id`'s chrome
/// bar — `host_str` is the kind (`action`/`height`), `path` the value.
fn dispatch_chrome_action<R: Runtime>(app: &AppHandle<R>, id: &str, url: &Url) {
    let value = url.path().trim_start_matches('/');
    match url.host_str() {
        Some("action") => {
            let Some(content) = app.get_webview(&content_label(id)) else {
                return;
            };
            let script = match value {
                "back" => "history.back()",
                "forward" => "history.forward()",
                "refresh" => "location.reload()",
                _ => return,
            };
            // Back click → a forward slot now exists, so enable Forward
            // (sticky; see [`InstanceState`]).
            if value == "back" {
                if let Some(instance) = instance_state(app, id) {
                    instance.nav_can_forward.store(true, Ordering::SeqCst);
                }
            }
            let _ = content.eval(script);
        }
        Some("height") => {
            // Reject `inf`/`NaN`/negatives/absurd values that `parse::<f64>`
            // accepts — any would poison the layout split (`logical_h -
            // chrome_height`) with no recovery path.
            const MAX_CHROME_HEIGHT: f64 = 4096.0;
            if let Ok(height) = value.parse::<f64>() {
                if height.is_finite() && (0.0..=MAX_CHROME_HEIGHT).contains(&height) {
                    if let Some(window) = app.get_window(&window_label(id)) {
                        apply_chrome_height(app, id, &window, height);
                    }
                }
            }
        }
        _ => {}
    }
}

/// The empty `200` every action fetch resolves to. The chrome `data:` document
/// has an opaque (`null`) origin, so the cross-origin fetch needs `ACAO` to
/// resolve without a console CORS error — the body is never read; the dispatch
/// is a pure side effect.
fn empty_scheme_response() -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(200)
        .header("Access-Control-Allow-Origin", "*")
        .body(Vec::new())
        .expect("a static empty 200 response is always well-formed")
}

/// Re-lay instance `id`'s chrome (top, full width, `chrome_height` tall) and the
/// content (everything below) for the given chrome height. Used both by the
/// chrome-reported height change and by the resize listener (which reads the
/// current height from [`InstanceState::chrome_height`]).
fn apply_chrome_height<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    window: &tauri::Window<R>,
    chrome_height: f64,
) {
    let Ok(window_size) = window.inner_size() else {
        return;
    };
    let scale = window.scale_factor().unwrap_or(1.0);
    let logical_w = window_size.width as f64 / scale;
    let logical_h = window_size.height as f64 / scale;

    let instance = instance_state(app, id);
    if let Some(instance) = &instance {
        // Best-effort: skip on a poisoned lock rather than panic (see [`lock_state`]).
        if let Ok(mut height) = instance.chrome_height.lock() {
            *height = chrome_height;
        }
    }

    // Skip the relayout when the last *applied* layout matches — see
    // [`InstanceState::applied_layout`].
    let next = (logical_w, logical_h, chrome_height);
    if let Some(instance) = &instance {
        // A poisoned lock just forgoes the dedup (fall through + relayout).
        if let Ok(guard) = instance.applied_layout.lock() {
            if *guard == Some(next) {
                return;
            }
        }
    }

    // Lay out whichever children are present. Either can be momentarily absent
    // mid-rebuild — a reopen tears the child webviews down and re-adds them.
    let chrome = app.get_webview(&chrome_label(id));
    let content = app.get_webview(&content_label(id));
    if let Some(chrome) = &chrome {
        let _ = chrome.set_position(LogicalPosition::<f64>::new(0.0, 0.0));
        let _ = chrome.set_size(LogicalSize::<f64>::new(logical_w, chrome_height));
    }
    if let Some(content) = &content {
        let _ = content.set_position(LogicalPosition::<f64>::new(0.0, chrome_height));
        let _ = content.set_size(LogicalSize::<f64>::new(
            logical_w,
            (logical_h - chrome_height).max(0.0),
        ));
    }

    // Record the dedup key only once BOTH children were present and laid out: a
    // key recorded while a child was still absent would make a later identical
    // resize short-circuit and never place the now-present webview, leaving it
    // mis-sized until some *different* resize. See [`InstanceState::applied_layout`].
    if chrome.is_some() && content.is_some() {
        if let Some(instance) = &instance {
            if let Ok(mut guard) = instance.applied_layout.lock() {
                *guard = Some(next);
            }
        }
    }
}

/// Instance `id`'s window lifecycle hooks:
///
/// - **Resized**: re-lay chrome (top) + content (rest) at the stored
///   [`InstanceState::chrome_height`] so they always tile the parent exactly.
/// - **CloseRequested**: titlebar X (no `disposing`) → user dismissal: hide +
///   emit `Hidden` (docs/Lifecycle and Races Explanation.md § "User dismissal hides; only
///   `dispose` tears down"). `disposing` set → resolve the dispose→open race via
///   [`InstanceState::pending_reopen`] (§ "The dispose→open \"switch-demo\" race").
/// - **Destroyed**: emit `Disposed` and clear [`InstanceState::disposing`].
///   Reached by host `dispose()`, the [`ABSOLUTE_TIMEOUT`] backstop, or app-exit
///   window teardown (§ "Teardown backstops").
///
/// `on_window_event` takes a `Fn(&WindowEvent) + Send + 'static`, so captures
/// are clones; the channel is read from [`InstanceState::current_channel`] at
/// fire time (not captured) so rewires take effect. The `id` is captured so
/// every handler resolves *this* instance's state.
fn install_window_listeners<R: Runtime>(app: &AppHandle<R>, id: &str, window: &tauri::Window<R>) {
    let app_window = app.clone();
    let window_clone = window.clone();
    let id = id.to_owned();
    window.on_window_event(move |event| match event {
        WindowEvent::Resized(_size) => {
            let height = instance_state(&app_window, &id)
                .and_then(|instance| instance.chrome_height.lock().ok().map(|height| *height))
                .unwrap_or(CHROME_HEIGHT_BASE);
            apply_chrome_height(&app_window, &id, &window_clone, height);
        }
        WindowEvent::CloseRequested { api, .. } => {
            let Some(instance) = instance_state(&app_window, &id) else {
                return;
            };
            // No `disposing` → user dismissal (titlebar X): hide + emit `Hidden`.
            // (App teardown destroys windows on a path that bypasses `prevent_close`.)
            if !instance.disposing.load(Ordering::SeqCst) {
                api.prevent_close();
                let _ = window_clone.hide();
                if let Ok(channel) = instance.current_channel.lock() {
                    let _ = channel.send(NativeWebviewEvent::Hidden);
                }
                return;
            }
            // `dispose()` in flight: take any deferred replay (see [`InstanceState`]).
            // `Some` → cancel + replay; `None` → let the dispose land.
            let pending = match instance.pending_reopen.lock() {
                Ok(mut guard) => guard.take(),
                // Poisoned lock: can't consult the slot → let the dispose proceed.
                Err(_) => return,
            };
            let Some((payload, target)) = pending else {
                return;
            };
            api.prevent_close();
            instance.disposing.store(false, Ordering::SeqCst);
            let Some(content) = app_window.get_webview(&content_label(&id)) else {
                return;
            };
            // Navigate straight to the target — a cookie-seeding open's writes
            // were queued by the caller thread ahead of this replay (see
            // [`present`]'s pending-reopen note).
            let _ = apply_rewire(&app_window, &id, &content, &payload, target.clone(), target);
        }
        WindowEvent::Destroyed => {
            let Some(instance) = instance_state(&app_window, &id) else {
                return;
            };
            // Notify the current caller's channel
            // ([`InstanceState::current_channel`]) that the webview is gone.
            if let Ok(channel) = instance.current_channel.lock() {
                let _ = channel.send(NativeWebviewEvent::Disposed);
            }
            instance.disposing.store(false, Ordering::SeqCst);
            // Advance the generation + wake so the backstop thread for the
            // now-destroyed webview exits immediately instead of parking out
            // the full ABSOLUTE_TIMEOUT (its fire would no-op on the missing
            // window anyway). See [`arm_absolute_timeout`].
            instance.timeout_generation.fetch_add(1, Ordering::SeqCst);
            instance.timeout_changed.notify_all();
            // Drop any payload that raced a close-that-actually-landed (a
            // tiny lossy edge only for off-main-thread close+open callers;
            // the listener-thread case runs `present()` before the close).
            if let Ok(mut pending) = instance.pending_reopen.lock() {
                *pending = None;
            };
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Decode the base64 `data:text/html` URL [`build_chrome_data_url`] produces
    /// back to its HTML source so tests can inspect the seeded state.
    fn decode_html(url: &Url) -> String {
        let encoded = url
            .as_str()
            .split_once("base64,")
            .expect("data URL carries a base64 payload")
            .1;
        let bytes = BASE64.decode(encoded).expect("valid base64");
        String::from_utf8(bytes).expect("utf-8 HTML")
    }

    /// A caller-supplied title containing `</script>` must not break out of the
    /// chrome's inline `<script>` element: `<` is unicode-escaped in the seeded
    /// JSON (it decodes back to `<` inside the JS string, harmlessly).
    #[test]
    fn build_chrome_data_url_escapes_script_breakout() {
        let url = build_chrome_data_url(&InitialChromeState {
            url: "https://example.test/",
            title: Some("</script><img src=x onerror=alert(1)>"),
            subtitle: None,
            message: None,
        })
        .expect("builds a data URL");
        let html = decode_html(&url);
        // No literal `</script>` from the caller value survives into the doc.
        assert!(!html.contains("</script><img"));
        assert!(html.contains("\\u003c/script>"));
    }

    /// Unclaimed slots ride as JSON `null` (the chrome reads `state.x != null`
    /// to decide whether the caller has claimed that slot), and a claimed slot
    /// plus the URL ride as their literal strings.
    #[test]
    fn build_chrome_data_url_seeds_url_and_claims() {
        let url = build_chrome_data_url(&InitialChromeState {
            url: "https://example.test/page",
            title: None,
            subtitle: Some("Collecting"),
            message: None,
        })
        .expect("builds a data URL");
        let html = decode_html(&url);
        assert!(html.contains("\"url\":\"https://example.test/page\""));
        assert!(html.contains("\"subtitle\":\"Collecting\""));
        // Title unclaimed → null → the chrome paints the URL into the title.
        assert!(html.contains("\"title\":null"));
        assert!(html.contains("\"message\":null"));
    }

    /// The per-instance labels are distinct across the three surfaces and, for a
    /// chrome label, round-trip back to the id via [`id_from_chrome_label`] — the
    /// path the action-scheme handler relies on to route to the right instance.
    /// An id with an *internal* `-chrome` still round-trips (only one trailing
    /// `-chrome` suffix is stripped), and a content/window label is rejected (the
    /// handler must ignore requests from a non-chrome webview). Note: an id that
    /// *ends* in `-chrome`/`-content` is inherently ambiguous with another
    /// instance's window/content label — the real ids (`sniffer`/`launch`) don't,
    /// so we don't validate against it.
    #[test]
    fn instance_labels_round_trip_through_chrome_label() {
        for id in ["sniffer", "launch", "my-chrome-app"] {
            assert_eq!(id_from_chrome_label(&chrome_label(id)), Some(id));
            // Distinct across surfaces so two instances never collide.
            assert_ne!(window_label(id), chrome_label(id));
            assert_ne!(window_label(id), content_label(id));
            assert_ne!(chrome_label(id), content_label(id));
            // A content/window label is not a chrome label → no id recovered.
            assert_eq!(id_from_chrome_label(&content_label(id)), None);
            assert_eq!(id_from_chrome_label(&window_label(id)), None);
        }
    }

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
