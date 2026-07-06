//! Desktop backend. Mirrors the iOS/Android layout via Tauri's
//! multi-webview-per-window API (`Window::add_child`, `unstable` feature): a
//! chrome bar (title / subtitle / message + back / forward / refresh) anchored
//! at the top and the external content webview below, sharing one parent
//! `Window`. The cross-platform lifecycle/race protocols this implements live in
//! [docs/Lifecycle and Races Explanation.md](../docs/Lifecycle%20and%20Races%20Explanation.md); the
//! higher-level "what / why" in [docs/Explanation.md](../docs/Explanation.md).
//!
//! ## Chrome ↔ Rust IPC
//!
//! The chrome webview loads its DOM from a base64 `data:text/html` URL (the
//! [`CHROME_HTML_TEMPLATE`] document, see [`build_chrome_data_url`]).
//! Communication stays inside the chrome webview's own `on_navigation` hook —
//! no `__TAURI__` event bus access required:
//!
//! - **Chrome → Rust**: button clicks set `window.location.href` to a
//!   [`CHROME_ACTION_SCHEME`] URL; `on_navigation` dispatches the matching
//!   `eval` on the content webview and returns `false` to cancel the (would-fail)
//!   nav. The cancel is the load guard; the dispatch is the side effect.
//! - **Rust → Chrome**: `webview.eval(...)` (e.g. [`WINDOW_TEXT_FN`]) — Rust-
//!   initiated, so it bypasses capability checks and the chrome's `data:` origin
//!   needs no capability entry.
//!
//! Caveat vs. mobile: both webviews are Tauri webviews here, so the content one
//! still has `window.__TAURI__`; the host app's capability JSON scopes it to
//! event-bus listen plus the gated `native_webview_data_plane_emit` command (no
//! bus `emit`, no log) — see `capabilities/native-webview-window.json`.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::de::DeserializeOwned;
use tauri::{
    ipc::Channel, plugin::PluginApi, webview::WebviewBuilder, window::WindowBuilder, AppHandle,
    LogicalPosition, LogicalSize, Manager, Runtime, WebviewUrl, WindowEvent,
};
use url::Url;

use crate::models::{
    CookieSameSite, CookieSpec, EvaluateJsRequest, NativeWebviewEvent, OpenRequest,
    PatchWindowTextRequest,
};

/// Label for the desktop native-webview parent window.
/// `capabilities/native-webview-window.json` keys on it to scope the grant.
const WINDOW_LABEL: &str = "native-webview";

/// Teardown backstop — see docs/Lifecycle and Races Explanation.md § "Teardown backstops"
/// (desktop's absolute-lifetime cap; re-armed per `open_url` via
/// [`arm_absolute_timeout`], superseded via [`PluginState::timeout_generation`]).
const ABSOLUTE_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// Label for the chrome (top bar) child webview.
const CHROME_WEBVIEW_LABEL: &str = "native-webview-chrome";
/// Label for the content (external URL) child webview.
const CONTENT_WEBVIEW_LABEL: &str = "native-webview-content";

/// Logical-px chrome bar height in its compact state (title + nav buttons, no
/// subtitle), with a sliver above the ~50px nav-button floor. The expanded
/// "title + subtitle" height lives in the chrome JS, which owns the visibility
/// check and reports its height back via `x-nv-action://height/<n>` — Rust
/// treats that value as opaque.
const CHROME_HEIGHT_BASE: f64 = 52.0;

/// Custom scheme the chrome's navigations target; caught by `on_navigation`,
/// never loaded. URL shapes:
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
/// `can_go_forward` predicates — see [`NavState`] for the approximation.
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
    cookie.set_secure(spec.secure);
    cookie.set_http_only(spec.http_only);
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
/// thread: each `set_cookie` is a fire-and-forget message the main loop
/// processes on its own iteration, where the wry write blocks until it commits
/// (macOS pumps the run loop for the `WKHTTPCookieStore` completion, Linux
/// spins `gtk::main_iteration()`). Because the loop is FIFO, a `navigate`
/// queued after this call only runs once every cookie has committed — that
/// ordering is the whole seeding contract. Calling this ON the main thread
/// instead executes the wry write inline, nesting its run-loop pump inside
/// tao's event handler — which kills the webview content processes and
/// deadlocks the app (observed on macOS).
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
        disposing: AtomicBool::new(false),
        pending_reopen: Mutex::new(None),
        timeout_generation: AtomicU64::new(0),
        timeout_wait: Mutex::new(()),
        timeout_changed: Condvar::new(),
    });
    Ok(NativeWebview(app.clone()))
}

/// App-managed coordination state for the dispose→open "switch-demo" race —
/// see docs/Lifecycle and Races Explanation.md § "The dispose→open \"switch-demo\" race".
///
/// Site-specific: `WebviewWindow::close()` only *queues* a `WindowMessage::Close`
/// via the runtime proxy (`runtime-wry/lib.rs::WindowDispatcher::close`) and
/// returns immediately, which is why the same-tick `present()` runs before
/// `CloseRequested` and the deferral is needed.
struct PluginState {
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
    /// from OFF the main thread: the webview is built/rewired at `about:blank`,
    /// then this (caller) thread queues the cookie writes and the navigation to
    /// the real target onto the main loop — FIFO, so every cookie commits
    /// before the target's first request fires. Doing the writes inside the
    /// main-thread `present()` instead nests wry's blocking cookie pump inside
    /// tao's event handler and deadlocks (see [`seed_cookies`]).
    pub fn open_url(&self, mut payload: OpenRequest) -> crate::Result<()> {
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
        self.0.run_on_main_thread(move || {
            // Best-effort: rx is dropped only when the caller already exited.
            let _ = tx.send(present(&app, payload, present_target, build_url));
        })?;
        rx.recv()
            .map_err(|error| crate::Error::Internal(error.to_string()))??;
        if !cookies.is_empty() {
            let content = self.0.get_webview(CONTENT_WEBVIEW_LABEL).ok_or_else(|| {
                crate::Error::Internal(
                    "native-webview content webview missing after a cookie-seeding open".to_owned(),
                )
            })?;
            seed_cookies(&content, &cookies)?;
            content.navigate(target)?;
        }
        Ok(())
    }

    /// Cookie **names** currently visible to the content webview for `url` —
    /// a read-back for verifying the pre-navigation cookie seeding (see
    /// [`OpenRequest`]'s `cookies`). Names only, never values: the point is
    /// observability ("did `wf_auth` land?"), not exfiltrating the jar.
    /// `Ok(None)` when no content webview is open. Desktop-only (mobile has no
    /// equivalent surface; wry's Android cookie read is a stub anyway).
    pub fn content_cookie_names_for_url(&self, url: Url) -> crate::Result<Option<Vec<String>>> {
        let Some(content) = self.0.get_webview(CONTENT_WEBVIEW_LABEL) else {
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
    pub fn evaluate_js(&self, payload: EvaluateJsRequest) -> crate::Result<()> {
        let content = self
            .0
            .get_webview(CONTENT_WEBVIEW_LABEL)
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
    pub fn patch_window_text(&self, payload: PatchWindowTextRequest) -> crate::Result<()> {
        let Some(chrome) = self.0.get_webview(CHROME_WEBVIEW_LABEL) else {
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
    pub fn show(&self) -> crate::Result<()> {
        if let Some(window) = self.0.get_window(WINDOW_LABEL) {
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
    pub fn hide(&self) -> crate::Result<()> {
        let Some(window) = self.0.get_window(WINDOW_LABEL) else {
            return Ok(());
        };
        window.hide()?;
        if let Some(state) = window.try_state::<CurrentChannel>() {
            if let Ok(channel) = state.0.lock() {
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
    pub fn dispose(&self) -> crate::Result<()> {
        let Some(window) = self.0.get_window(WINDOW_LABEL) else {
            return Ok(());
        };
        if let Some(state) = self.0.try_state::<PluginState>() {
            state.disposing.store(true, Ordering::SeqCst);
        }
        window.close()?;
        Ok(())
    }
}

/// Arm (or re-arm) the [`ABSOLUTE_TIMEOUT`] backstop — see docs/Lifecycle and
/// Races Explanation.md § "Teardown backstops". Bumps [`PluginState::timeout_generation`]
/// (superseding any prior timer), wakes the prior generation's parked thread so
/// it exits immediately, and spawns a parked thread (no async runtime
/// dependency; ≤1 live across rapid reopens, since each re-arm releases the last)
/// that disposes on fire iff its captured generation is still current. On fire it
/// mirrors a host `dispose()` (set `disposing`, `window.close()`).
fn arm_absolute_timeout<R: Runtime>(app: &AppHandle<R>) {
    let Some(state) = app.try_state::<PluginState>() else {
        return;
    };
    let generation = state.timeout_generation.fetch_add(1, Ordering::SeqCst) + 1;
    // Release any prior generation's parked thread now that it's superseded.
    state.timeout_changed.notify_all();
    let app = app.clone();
    std::thread::spawn(move || {
        let Some(state) = app.try_state::<PluginState>() else {
            return;
        };
        // Park until ABSOLUTE_TIMEOUT elapses OR this generation is superseded
        // (a re-arm or teardown bumps the generation and notifies). A poisoned
        // condvar mutex just drops the backstop — teardown handles itself.
        let Ok(guard) = state.timeout_wait.lock() else {
            return;
        };
        let Ok((_guard, wait)) =
            state
                .timeout_changed
                .wait_timeout_while(guard, ABSOLUTE_TIMEOUT, |()| {
                    state.timeout_generation.load(Ordering::SeqCst) == generation
                })
        else {
            return;
        };
        // Superseded before the timeout → this generation is stale, exit.
        if !wait.timed_out() {
            return;
        }
        let handle = app.clone();
        // Window ops are main-thread on macOS. A failed marshal (app shutting
        // down) just drops the backstop — teardown is happening anyway.
        let _ = app.run_on_main_thread(move || {
            let Some(state) = handle.try_state::<PluginState>() else {
                return;
            };
            // Stale (a reopen/teardown advanced the generation between the wait
            // returning and this marshal) → no-op.
            if state.timeout_generation.load(Ordering::SeqCst) != generation {
                return;
            }
            let Some(window) = handle.get_window(WINDOW_LABEL) else {
                return;
            };
            state.disposing.store(true, Ordering::SeqCst);
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
    payload: OpenRequest,
    target_url: Url,
    build_url: Url,
) -> crate::Result<()> {
    // Dispose in flight: defer the replay (last-write-wins on a rapid double-
    // `open`). See [`PluginState`]. The replay stores the TARGET: by the time
    // it runs, the caller thread's cookie writes are queued/committed, so
    // navigating straight to the target is correct (and parking on
    // `about:blank` would strand the popup — nobody re-navigates a replay).
    if let Some(state) = app.try_state::<PluginState>() {
        if state.disposing.load(Ordering::SeqCst) {
            *lock_state(&state.pending_reopen, "pending-reopen")? = Some((payload, target_url));
            return Ok(());
        }
    }

    // Already open: rewire in place rather than rebuild.
    if let Some(content) = app.get_webview(CONTENT_WEBVIEW_LABEL) {
        apply_rewire(app, &content, &payload, target_url, build_url)?;
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
    let window = WindowBuilder::new(app, WINDOW_LABEL)
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
    // DOMContentLoaded) and the resize listener find the state present.
    install_native_webview_state(&window, channel)?;

    // Chrome webview. The initial state is baked into the `data:` HTML (vs a
    // post-open patch) so the bar is correct on first paint — see the Lifecycle
    // & Races doc § "Chrome URL-fallback". `on_navigation` catches the
    // [`CHROME_ACTION_SCHEME`] clicks + height reports, returning false to cancel.
    let chrome_url = build_chrome_data_url(&InitialChromeState {
        url: &initial_url,
        title: payload.initial_title.as_deref(),
        subtitle: payload.initial_subtitle.as_deref(),
        message: payload.initial_message.as_deref(),
    })?;
    let app_for_actions = app.clone();
    let window_for_actions = window.clone();
    let chrome_builder = WebviewBuilder::new(
        CHROME_WEBVIEW_LABEL,
        WebviewUrl::External(chrome_url),
    )
    .on_navigation(move |url| {
        if url.scheme() != CHROME_ACTION_SCHEME {
            return true;
        }
        // `x-nv-action://<kind>/<value>`: `host_str` is the kind, `path` the value.
        let value = url.path().trim_start_matches('/');
        match url.host_str() {
            Some("action") => {
                let Some(content) = app_for_actions.get_webview(CONTENT_WEBVIEW_LABEL) else {
                    return false;
                };
                let script = match value {
                    "back" => "history.back()",
                    "forward" => "history.forward()",
                    "refresh" => "location.reload()",
                    _ => return false,
                };
                // Back click → a forward slot now exists, so enable Forward
                // (sticky; see [`NavState`]).
                if value == "back" {
                    if let Some(window) = app_for_actions.get_window(WINDOW_LABEL) {
                        if let Some(state) = window.try_state::<NavState>() {
                            state.can_forward.store(true, Ordering::SeqCst);
                        }
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
                        apply_chrome_height(&app_for_actions, &window_for_actions, height);
                    }
                }
            }
            _ => {}
        }
        false
    });
    window.add_child(
        chrome_builder,
        LogicalPosition::<f64>::new(0.0, 0.0),
        LogicalSize::<f64>::new(logical_width, CHROME_HEIGHT_BASE),
    )?;

    // Content webview: built at `build_url` — the external target, except on a
    // cookie-seeding open, where it parks at `about:blank` until the caller
    // thread's queued cookie writes commit (see [`NativeWebview::open_url`]).
    let mut content_builder =
        WebviewBuilder::new(CONTENT_WEBVIEW_LABEL, WebviewUrl::External(build_url));
    if let Some(script) = init_script {
        content_builder = content_builder.initialization_script(script);
    }
    // Sync the chrome URL fallback (see docs/Lifecycle and Races Explanation.md § "Chrome
    // URL-fallback") + back/forward state on each page load. `Started` (not
    // `Finished`) so it lands as the navigation commits. See [`NavState`].
    let app_for_loads = app.clone();
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
        // so it still fires if `NavState` is somehow absent.
        if let Some(chrome) = app_for_loads.get_webview(CHROME_WEBVIEW_LABEL) {
            if let Ok(arg) = serde_json::to_string(payload.url().as_str()) {
                let _ = chrome.eval(format!("{CHROME_SET_URL_FN}({arg})"));
            }
        }
        let Some(window) = app_for_loads.get_window(WINDOW_LABEL) else {
            return;
        };
        let Some(state) = window.try_state::<NavState>() else {
            return;
        };
        let new_count = {
            // Best-effort in a page-load callback: skip the nav-state update on
            // a poisoned lock rather than panicking.
            let Ok(mut count) = state.load_count.lock() else {
                return;
            };
            *count = count.saturating_add(1);
            *count
        };
        let can_back = new_count > 1;
        let can_forward = state.can_forward.load(Ordering::SeqCst);
        if let Some(chrome) = app_for_loads.get_webview(CHROME_WEBVIEW_LABEL) {
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

    install_window_listeners(app, &window);
    arm_absolute_timeout(app);

    Ok(())
}

/// Per-native-webview state holding the chrome's current logical-px height —
/// (re)initialised by [`install_native_webview_state`] on each open. Read by the resize
/// listener (so window resize keeps the right vertical split) and written by
/// the chrome → Rust height-report navigation.
struct ChromeHeight(Mutex<f64>);

/// Last `(logical_w, logical_h, chrome_height)` actually applied to **both**
/// child webviews. `apply_chrome_height` short-circuits when the next layout
/// matches, so a no-op resize tick or a message-only `patch_window_text` (which
/// re-reports the same height) doesn't re-issue the four `set_position` /
/// `set_size` calls across both webviews. Written only after both children were
/// present and laid out — a layout attempted while a child was mid-rebuild is
/// not recorded, so the next resize still reaches the now-present webview.
struct AppliedLayout(Mutex<Option<(f64, f64, f64)>>);

/// Per-native-webview state holding the [`Channel<NativeWebviewEvent>`] events
/// fire on. Set per open by [`install_native_webview_state`] and re-bound by
/// [`apply_rewire`] so a second `open()` routes subsequent events (the `Hidden`
/// from a dismissal, the `Disposed` from `Destroyed`) to the latest caller —
/// see docs/Lifecycle and Races Explanation.md § "Re-open rewire".
struct CurrentChannel(Mutex<Channel<NativeWebviewEvent>>);

/// Per-native-webview Rust-side approximation of the content webview's nav
/// history (Tauri's `Webview` exposes no `can_go_back` / `can_go_forward`).
/// Not in the cross-platform doc — desktop-only. Initialised per fresh webview
/// by [`install_native_webview_state`].
///
/// - `load_count`: ++ on every content Started load; `canBack` = `> 1`. NOT
///   reset by [`apply_rewire`] — a sniffer-driven nav reuses the same content
///   webview whose history persists across `navigate`, so Back must stay enabled
///   once ≥2 pages loaded. Only a fresh window starts it at 0.
/// - `can_forward`: set `true` when the chrome Back button fires; left sticky
///   (we can't tell a back-induced load from a fresh link-click at the Rust
///   layer, so clearing it per load would wrongly disable Forward the instant a
///   back commits). [`apply_rewire`] clears it (fresh nav truncates the forward
///   stack). Cost: Forward can linger enabled after a new link, where pressing
///   it is a harmless no-op `history.forward()` past the end.
struct NavState {
    load_count: Mutex<u32>,
    can_forward: AtomicBool,
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

/// Install (first open) or reset (reopen) the per-native-webview window state:
/// [`ChromeHeight`], [`AppliedLayout`], [`CurrentChannel`], [`NavState`].
///
/// Site-specific (not in the cross-platform doc): `window.manage` writes
/// APP-GLOBAL state via a set-once `StateManager` — a `Window`'s manager is the
/// shared `AppManager`, not a per-window map — so on a reopen of this single
/// reusable window (label `native-webview`) every `manage` below no-ops and the
/// cells still hold the prior webview's values. Hence we `manage` to create the
/// cells once and unconditionally reset their contents on every open.
fn install_native_webview_state<R: Runtime>(
    window: &tauri::Window<R>,
    channel: Channel<NativeWebviewEvent>,
) -> crate::Result<()> {
    // `manage` returns `false` when already managed (reopen) → reset the cell.
    if !window.manage(ChromeHeight(Mutex::new(CHROME_HEIGHT_BASE))) {
        if let Some(state) = window.try_state::<ChromeHeight>() {
            *lock_state(&state.0, "chrome-height")? = CHROME_HEIGHT_BASE;
        }
    }
    if !window.manage(AppliedLayout(Mutex::new(None))) {
        if let Some(state) = window.try_state::<AppliedLayout>() {
            *lock_state(&state.0, "applied-layout")? = None;
        }
    }
    if !window.manage(CurrentChannel(Mutex::new(channel.clone()))) {
        if let Some(state) = window.try_state::<CurrentChannel>() {
            *lock_state(&state.0, "current-channel")? = channel;
        }
    }
    if !window.manage(NavState {
        load_count: Mutex::new(0),
        can_forward: AtomicBool::new(false),
    }) {
        if let Some(state) = window.try_state::<NavState>() {
            *lock_state(&state.load_count, "nav-load-count")? = 0;
            state.can_forward.store(false, Ordering::SeqCst);
        }
    }
    Ok(())
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
    content: &tauri::webview::Webview<R>,
    payload: &OpenRequest,
    target: Url,
    navigate_to: Url,
) -> crate::Result<()> {
    if let Some(window) = app.get_window(WINDOW_LABEL) {
        if let Some(state) = window.try_state::<CurrentChannel>() {
            *lock_state(&state.0, "current-channel")? =
                payload.native_webview_event_channel.clone();
        }
        // Same content webview → keep `load_count` (Back stays enabled); only
        // clear `can_forward` (fresh nav truncates the forward stack). See [`NavState`].
        if let Some(state) = window.try_state::<NavState>() {
            state.can_forward.store(false, Ordering::SeqCst);
        }
    }
    if let Some(script) = &payload.init_script {
        let _ = content.eval(script);
    }
    if let Some(chrome) = app.get_webview(CHROME_WEBVIEW_LABEL) {
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
    let _ = content.navigate(navigate_to);
    // A reopen starts a new task clock — re-arm the backstop.
    arm_absolute_timeout(app);
    Ok(())
}

/// Re-lay the chrome (top, full width, `chrome_height` tall) and the
/// content (everything below) for the given chrome height. Used both by
/// the chrome-reported height change and by the resize listener (which
/// reads the current height from `ChromeHeight` state).
fn apply_chrome_height<R: Runtime>(
    app: &AppHandle<R>,
    window: &tauri::Window<R>,
    chrome_height: f64,
) {
    let Ok(window_size) = window.inner_size() else {
        return;
    };
    let scale = window.scale_factor().unwrap_or(1.0);
    let logical_w = window_size.width as f64 / scale;
    let logical_h = window_size.height as f64 / scale;

    if let Some(state) = window.try_state::<ChromeHeight>() {
        // Best-effort: skip on a poisoned lock rather than panic (see [`lock_state`]).
        if let Ok(mut height) = state.0.lock() {
            *height = chrome_height;
        }
    }

    // Skip the relayout when the last *applied* layout matches — see [`AppliedLayout`].
    let next = (logical_w, logical_h, chrome_height);
    if let Some(applied) = window.try_state::<AppliedLayout>() {
        // A poisoned lock just forgoes the dedup (fall through + relayout).
        if let Ok(guard) = applied.0.lock() {
            if *guard == Some(next) {
                return;
            }
        }
    }

    // Lay out whichever children are present. Either can be momentarily absent
    // mid-rebuild — a reopen tears the child webviews down and re-adds them.
    let chrome = app.get_webview(CHROME_WEBVIEW_LABEL);
    let content = app.get_webview(CONTENT_WEBVIEW_LABEL);
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
    // mis-sized until some *different* resize. See [`AppliedLayout`].
    if chrome.is_some() && content.is_some() {
        if let Some(applied) = window.try_state::<AppliedLayout>() {
            if let Ok(mut guard) = applied.0.lock() {
                *guard = Some(next);
            }
        }
    }
}

/// Window lifecycle hooks:
///
/// - **Resized**: re-lay chrome (top) + content (rest) at the stored
///   [`ChromeHeight`] so they always tile the parent exactly.
/// - **CloseRequested**: titlebar X (no `disposing`) → user dismissal: hide +
///   emit `Hidden` (docs/Lifecycle and Races Explanation.md § "User dismissal hides; only
///   `dispose` tears down"). `disposing` set → resolve the dispose→open race via
///   [`PluginState::pending_reopen`] (§ "The dispose→open \"switch-demo\" race").
/// - **Destroyed**: emit `Disposed` and clear [`PluginState::disposing`].
///   Reached by host `dispose()`, the [`ABSOLUTE_TIMEOUT`] backstop, or app-exit
///   window teardown (§ "Teardown backstops").
///
/// `on_window_event` takes a `Fn(&WindowEvent) + Send + 'static`, so captures
/// are clones; the channel is read from [`CurrentChannel`] at fire time (not
/// captured) so rewires take effect.
fn install_window_listeners<R: Runtime>(app: &AppHandle<R>, window: &tauri::Window<R>) {
    let app_window = app.clone();
    let window_clone = window.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::Resized(_size) => {
            let height = window_clone
                .try_state::<ChromeHeight>()
                .and_then(|s| s.0.lock().ok().map(|height| *height))
                .unwrap_or(CHROME_HEIGHT_BASE);
            apply_chrome_height(&app_window, &window_clone, height);
        }
        WindowEvent::CloseRequested { api, .. } => {
            let Some(state) = app_window.try_state::<PluginState>() else {
                return;
            };
            // No `disposing` → user dismissal (titlebar X): hide + emit `Hidden`.
            // (App teardown destroys windows on a path that bypasses `prevent_close`.)
            if !state.disposing.load(Ordering::SeqCst) {
                api.prevent_close();
                let _ = window_clone.hide();
                if let Some(channel_state) = window_clone.try_state::<CurrentChannel>() {
                    if let Ok(channel) = channel_state.0.lock() {
                        let _ = channel.send(NativeWebviewEvent::Hidden);
                    }
                }
                return;
            }
            // `dispose()` in flight: take any deferred replay (see [`PluginState`]).
            // `Some` → cancel + replay; `None` → let the dispose land.
            let pending = match state.pending_reopen.lock() {
                Ok(mut guard) => guard.take(),
                // Poisoned lock: can't consult the slot → let the dispose proceed.
                Err(_) => return,
            };
            let Some((payload, target)) = pending else {
                return;
            };
            api.prevent_close();
            state.disposing.store(false, Ordering::SeqCst);
            let Some(content) = app_window.get_webview(CONTENT_WEBVIEW_LABEL) else {
                return;
            };
            // Navigate straight to the target — a cookie-seeding open's writes
            // were queued by the caller thread ahead of this replay (see
            // [`present`]'s pending-reopen note).
            let _ = apply_rewire(&app_window, &content, &payload, target.clone(), target);
        }
        WindowEvent::Destroyed => {
            // Notify the current caller's channel ([`CurrentChannel`]) that the
            // webview is gone.
            if let Some(state) = window_clone.try_state::<CurrentChannel>() {
                if let Ok(channel) = state.0.lock() {
                    let _ = channel.send(NativeWebviewEvent::Disposed);
                }
            }
            if let Some(state) = app_window.try_state::<PluginState>() {
                state.disposing.store(false, Ordering::SeqCst);
                // Advance the generation + wake so the backstop thread for the
                // now-destroyed webview exits immediately instead of parking out
                // the full ABSOLUTE_TIMEOUT (its fire would no-op on the missing
                // window anyway). See [`arm_absolute_timeout`].
                state.timeout_generation.fetch_add(1, Ordering::SeqCst);
                state.timeout_changed.notify_all();
                // Drop any payload that raced a close-that-actually-landed (a
                // tiny lossy edge only for off-main-thread close+open callers;
                // the listener-thread case runs `present()` before the close).
                if let Ok(mut pending) = state.pending_reopen.lock() {
                    *pending = None;
                }
            }
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
    }
}
