//! Desktop backend.
//!
//! Tauri's multi-webview-per-window API (`Window::add_child`, gated behind the
//! `unstable` feature) lets us mirror the iOS/Android native webview layout on
//! desktop: a chrome bar (title / subtitle / message + back / forward /
//! refresh) anchored at the top, and the external content webview below.
//! The two webviews share the same parent `Window` so the OS treats them as
//! one native webview; resize is handled by [`on_window_event`] which re-lays the
//! children on every resize tick.
//!
//! ## Chrome ↔ Rust IPC
//!
//! The chrome webview loads its DOM from a base64 `data:text/html` URL (the
//! [`CHROME_HTML_TEMPLATE`] document, see [`build_chrome_data_url`]).
//! Communication with Rust stays inside the webview's own `on_navigation`
//! hook — no `__TAURI__` event bus access required:
//!
//! - **Chrome → Rust**: button clicks set `window.location.href` to
//!   `x-nv-action://action/<back|forward|refresh>`. Rust's `on_navigation`
//!   matches the custom scheme, dispatches a `history.*` / `location.reload`
//!   `eval` on the content webview, and returns `false` to cancel the actual
//!   navigation (the unregistered scheme would error anyway). The cancel is
//!   the load guard; the dispatch is the side effect we wanted.
//!
//! - **Rust → Chrome**: `webview.eval("window.__nativeWebviewPatchWindowText({...})")`.
//!   `eval` is Rust-initiated and bypasses capability checks, so the chrome's
//!   `data:` origin can be entirely outside the capability allowlist.
//!
//! Caveat vs. mobile: both webviews are Tauri webviews here, so the content
//! one still has `window.__TAURI__`. The host app's capability JSON scopes it
//! to just the event bus + log (matching the pre-multi-webview posture). The
//! chrome webview doesn't appear in any capability — it doesn't need to,
//! since it uses no Tauri commands.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::de::DeserializeOwned;
use tauri::{
    ipc::Channel, plugin::PluginApi, webview::WebviewBuilder, window::WindowBuilder, AppHandle,
    LogicalPosition, LogicalSize, Manager, Runtime, WebviewUrl, WindowEvent,
};
use url::Url;

use crate::models::{EvaluateJsRequest, NativeWebviewEvent, OpenRequest, PatchWindowTextRequest};

/// Label for the desktop native-webview parent window.
/// `capabilities/native-webview-window.json` keys on it to scope the grant.
const WINDOW_LABEL: &str = "native-webview";

/// Absolute lifetime cap for a desktop native webview: no presented task may run
/// longer than this, hidden or not. Desktop has no hidden-idle reclaim (mobile
/// arms a 5-minute idle teardown via `idleTeardownSeconds` / `IDLE_TEARDOWN_MS`);
/// without this, a user who dismisses the sniffer leaves an untrusted
/// third-party page running indefinitely. Re-armed on every `open_url` (a fresh
/// build or an in-place reopen each start a new task clock); a teardown or reopen
/// makes the previously-armed timer a no-op via [`PluginState::timeout_generation`].
const ABSOLUTE_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// Label for the chrome (top bar) child webview.
const CHROME_WEBVIEW_LABEL: &str = "native-webview-chrome";
/// Label for the content (external URL) child webview.
const CONTENT_WEBVIEW_LABEL: &str = "native-webview-content";

/// Logical pixels — chrome bar height in its compact state (title + nav
/// buttons, no subtitle). The button-driven floor (`18px` icon + `6px*2`
/// padding + `8px+12px` body padding ≈ 50px) drives the lower bound here;
/// 52 leaves a sliver of breathing room.
///
/// The expanded "title + subtitle" height (68px) is hard-coded inside the
/// chrome JS rather than mirrored here because the JS owns the visibility
/// check and reports the resulting height back via the
/// `x-nv-action://height/<n>` channel — Rust treats the value as opaque.
const CHROME_HEIGHT_BASE: f64 = 52.0;

/// Custom scheme the chrome's button-click + height-report navigations
/// target. Caught by the chrome webview's `on_navigation` handler; never
/// actually loaded.
///
/// URL shapes:
/// - `x-nv-action://action/<back|forward|refresh>` — button click;
///   Rust dispatches the matching history call on the content webview.
/// - `x-nv-action://height/<logical_px>` — chrome reports its desired
///   height (e.g. 48 collapsed, 64 with subtitle); Rust resizes the
///   chrome + content webviews to match.
const CHROME_ACTION_SCHEME: &str = "x-nv-action";

/// Rust → chrome state push: this global is defined by the chrome's init
/// script and invoked from Rust via `webview.eval(...)`.
const WINDOW_TEXT_FN: &str = "window.__nativeWebviewPatchWindowText";

/// Rust → chrome nav-state push for back/forward button enabled state.
/// Tracked Rust-side because Tauri's `Webview` API exposes no
/// `can_go_back` / `can_go_forward` predicates — we approximate from the
/// `on_page_load` hook + chrome action interception (back click flips
/// `canForward` on).
const CHROME_NAV_STATE_FN: &str = "window.__nativeWebviewSetNavState";

/// Rust → chrome URL push: keeps the URL-fallback's `url` in sync with the
/// content webview's navigation, so whichever slot still shows the URL tracks
/// page loads. Invoked from `on_page_load` (Started).
const CHROME_SET_URL_FN: &str = "window.__nativeWebviewSetUrl";

/// Rust → chrome reset push for an in-place re-open (see [`apply_rewire`]):
/// clears the chrome's claim state + slots, seeds the new URL, and re-applies
/// the caller's initial chrome. Defined by the chrome's inline script.
const CHROME_RESET_TEXT_FN: &str = "window.__nativeWebviewResetWindowText";

/// Full HTML document the chrome webview loads as its source, kept as a
/// standalone [`chrome.html`](./chrome.html) so it can be edited and reasoned
/// about as HTML rather than a Rust string literal. It is base64-encoded into a
/// `data:text/html;base64,…` URL at runtime (see [`build_chrome_data_url`]) so
/// quotes / angle-brackets / spaces don't break `Url::parse`. The single
/// `__INITIAL_STATE__` placeholder is replaced with a JSON object
/// (`{url, title, subtitle, message}`) the chrome's inline script seeds its
/// URL-fallback state machine from, so the bar is correct on first paint with
/// no `about:blank` + init-script race.
const CHROME_HTML_TEMPLATE: &str = include_str!("chrome.html");

/// The `__INITIAL_STATE__` placeholder in [`CHROME_HTML_TEMPLATE`], replaced at
/// runtime with the JSON the chrome's inline script seeds itself from.
const CHROME_STATE_PLACEHOLDER: &str = "__INITIAL_STATE__";

/// The initial state the chrome's inline script seeds its URL-fallback state
/// machine from. Serialised to JSON and substituted into
/// [`CHROME_STATE_PLACEHOLDER`]. `title` / `subtitle` / `message` are `None`
/// (→ JSON `null` → "caller hasn't claimed this slot") unless the caller
/// supplied them on `open`; `url` is the full content URL the fallback paints
/// into whichever slot is still unclaimed.
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
/// No HTML-escaping of the caller values is needed: the chrome script assigns
/// them via `textContent` (never `innerHTML`), so they can't inject markup.
/// The one escape that matters is `<` in the JSON, which is replaced with its
/// `<` unicode escape so a caller value containing `</script>` can't break
/// out of the inline `<script>` element — JSON structure has no bare `<`, so a
/// blanket replace is safe and `<` decodes back to `<` in the JS string.
///
/// Note on `data:` URLs: the `url` crate offers no structural constructor for
/// opaque (non-special) schemes, so `Url::parse` is the only way to build one.
/// The input here is a fixed `data:text/html;base64,` prefix followed by base64
/// (whose alphabet `A–Za–z0–9+/=` is entirely URL-safe), so parsing cannot
/// fail — but we surface the error through `crate::Result` rather than
/// asserting with `.expect`, so a future template change that somehow produces
/// an invalid URL fails the `open` cleanly instead of panicking.
fn build_chrome_data_url(state: &InitialChromeState) -> crate::Result<Url> {
    let json = serde_json::to_string(state)
        .map_err(|error| crate::Error::Internal(error.to_string()))?
        .replace('<', "\\u003c");
    let html = CHROME_HTML_TEMPLATE.replace(CHROME_STATE_PLACEHOLDER, &json);
    let encoded = BASE64.encode(html.as_bytes());
    Url::parse(&format!("data:text/html;base64,{encoded}"))
        .map_err(|error| crate::Error::Internal(error.to_string()))
}

/// Build the desktop backend.
pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<NativeWebview<R>> {
    // App-managed coordination between `dispose()`, `present()`, and the native
    // webview window's `CloseRequested` handler — see [`PluginState`] for the race story.
    app.manage(PluginState {
        disposing: AtomicBool::new(false),
        pending_reopen: Mutex::new(None),
        timeout_generation: AtomicU64::new(0),
    });
    Ok(NativeWebview(app.clone()))
}

/// App-managed coordination state for the dispose/reopen race fix.
///
/// A "switch demos" sequence emits `SniffingComplete` → `dispose()` → and then
/// `RequestSniffableWebView` → `open_url()` on the same main-thread bridge
/// listener tick. `WebviewWindow::close()` only *queues* a `WindowMessage::Close`
/// via the runtime's proxy (see `runtime-wry/lib.rs::WindowDispatcher::close`)
/// and returns immediately, so the subsequent same-tick `present()` runs
/// *before* the `CloseRequested` event fires. Without coordination, `present()`
/// finds the doomed window via `get_webview` and navigates it in place — then
/// the queued dispose destroys the native webview and the user sees nothing.
///
/// The fix is to make the dispose cancellable: `dispose()` flips `disposing` to
/// `true` before asking the runtime to close, `present()` stashes its
/// `OpenRequest` payload in `pending_reopen` when it sees `disposing`, and the
/// window's `CloseRequested` handler reads `pending_reopen` to either
/// `prevent_close()` + re-wire (channel + initScript + chrome + URL) the
/// existing webviews, or let the dispose proceed when nothing is pending.
///
/// Only `dispose()` arms this — `hide()` keeps the window alive (`window.hide()`
/// fires no `CloseRequested`/`Destroyed`), so a `hide`+`open_url` sequence just
/// navigates the live, hidden webview with no deferral.
struct PluginState {
    /// `true` between the `dispose()` call and the `Destroyed` event that
    /// follows a non-cancelled dispose. Read by `present()` to defer building or
    /// re-wiring against a doomed window.
    disposing: AtomicBool,
    /// The deferred `present()` request while `disposing == true`, paired with
    /// its already-validated [`Url`] so the `CloseRequested` replay doesn't
    /// re-parse. The handler takes it (`Option::take`) — if `Some`, it cancels
    /// the dispose and replays the request against the existing webviews; if
    /// `None`, the dispose proceeds.
    pending_reopen: Mutex<Option<(OpenRequest, Url)>>,
    /// Monotonic generation for the [`ABSOLUTE_TIMEOUT`] backstop. Bumped by
    /// [`arm_absolute_timeout`] on every `open_url`; the spawned timer captures
    /// the value at arm time and disposes only if it's still current at fire
    /// time, so a reopen or teardown that advances it makes the stale timer a
    /// no-op (no need to hold a join handle to cancel).
    timeout_generation: AtomicU64,
}

/// Desktop handle to the native-webview plugin.
pub struct NativeWebview<R: Runtime>(AppHandle<R>);

impl<R: Runtime> NativeWebview<R> {
    /// Present the external URL in a native-webview `Window` with chrome + content
    /// child webviews. Window creation is marshalled onto the main thread
    /// (required on macOS) and the result is propagated back through a
    /// `sync_channel`.
    ///
    /// **Why a channel works without deadlock**: `run_on_main_thread` is
    /// synchronous when called from the main thread (`send_user_message`
    /// invokes `handle_user_message` inline when the current thread matches —
    /// see `tauri-runtime-wry`'s `send_user_message`). So when the bridge
    /// listener (main thread) calls `open()`, the closure has already run
    /// and `tx.send` already fired by the time `rx.recv()` is reached.
    /// Off-main-thread callers block waiting for the main thread to drain
    /// the queue, which is safe (no self-wait).
    pub fn open_url(&self, payload: OpenRequest) -> crate::Result<()> {
        // Validate + parse the URL exactly once here (http(s)-only — see
        // [`crate::url_scheme`]) and thread the parsed `Url` through to
        // `present`, so the build path doesn't re-parse and the scheme rule
        // lives in a single place rather than at every call site.
        let parsed = crate::url_scheme::parse_http_url(&payload.url)?;
        let app = self.0.clone();
        let (tx, rx) = std::sync::mpsc::sync_channel::<crate::Result<()>>(1);
        self.0.run_on_main_thread(move || {
            // Best-effort send: rx is dropped only if `run_on_main_thread`
            // returned an error AND the caller exited before we could
            // send — in which case nobody is reading anyway.
            let _ = tx.send(present(&app, payload, parsed));
        })?;
        rx.recv()
            .map_err(|error| crate::Error::Internal(error.to_string()))?
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
        // Serialise the request directly — the wire camelCase keys
        // (`title` / `subtitle` / `message`) match what
        // `__nativeWebviewPatchWindowText` reads.
        let json = serde_json::to_string(&payload)
            .map_err(|error| crate::Error::Internal(error.to_string()))?;
        chrome.eval(format!("{WINDOW_TEXT_FN}({json})"))?;
        Ok(())
    }

    /// Present the native webview window — reveal a freshly-built or
    /// previously-hidden instance. The window is built hidden by [`open_url`],
    /// so this is what makes it visible. Reveals immediately; a `show()` issued
    /// before the content's first paint may briefly flash the window background
    /// on macOS dark mode — accepted as the cost of separating presentation
    /// from navigation. Idempotent — no-op if no window exists.
    pub fn show(&self) -> crate::Result<()> {
        if let Some(window) = self.0.get_window(WINDOW_LABEL) {
            window.show()?;
            let _ = window.set_focus();
        }
        Ok(())
    }

    /// Hide the native webview window — remove it from view but keep it (and its
    /// child webviews) alive and running. `window.hide()` fires no
    /// `CloseRequested`/`Destroyed`, so nothing is torn down and a later
    /// [`open_url`]/[`show`] reuses the same live instance. Emits
    /// [`NativeWebviewEvent::Hidden`] on the current channel. Idempotent — no-op
    /// if no window exists.
    pub fn hide(&self) -> crate::Result<()> {
        let Some(window) = self.0.get_window(WINDOW_LABEL) else {
            return Ok(());
        };
        window.hide()?;
        // `Hidden` is emitted here directly: unlike a dispose, a hide produces
        // no `Destroyed` event for the window listener to translate.
        if let Some(state) = window.try_state::<CurrentChannel>() {
            if let Ok(channel) = state.0.lock() {
                let _ = channel.send(NativeWebviewEvent::Hidden);
            }
        }
        Ok(())
    }

    /// Dispose the native webview window — tear it down and free its resources.
    ///
    /// Flips [`PluginState::disposing`] before asking the runtime to close so a
    /// same-tick `open_url()` that races this dispose lands in the deferral
    /// branch of [`present`] (queued into `pending_reopen`) rather than building
    /// against the doomed window. See [`PluginState`] for the full race story.
    /// The `Destroyed` handler emits [`NativeWebviewEvent::Disposed`].
    /// Idempotent — no-op if no window exists.
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

/// Arm (or re-arm) the [`ABSOLUTE_TIMEOUT`] backstop for the current native
/// webview. Bumps [`PluginState::timeout_generation`] so any previously-armed
/// timer no-ops, captures the new generation, and spawns a thread that — after
/// the timeout — marshals back to the main thread and disposes the window iff
/// the generation is still current and a window still exists.
///
/// A parked thread (rather than the async runtime) keeps this dependency-free;
/// at most one is live per presented native webview, for at most the timeout
/// duration. The dispose mirrors a host `dispose()`: set `disposing` then
/// `window.close()`, so the `CloseRequested` / `Destroyed` path emits
/// `Disposed` and the host's collector releases per-native-webview state.
fn arm_absolute_timeout<R: Runtime>(app: &AppHandle<R>) {
    let Some(state) = app.try_state::<PluginState>() else {
        return;
    };
    // Supersede any timer armed by a prior `open_url` and claim this generation.
    let generation = state.timeout_generation.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(ABSOLUTE_TIMEOUT);
        let handle = app.clone();
        // Window ops are main-thread on macOS. A failed marshal (app shutting
        // down) just drops the backstop — teardown is happening anyway.
        let _ = app.run_on_main_thread(move || {
            let Some(state) = handle.try_state::<PluginState>() else {
                return;
            };
            // A reopen or teardown advanced the generation — this timer is stale.
            if state.timeout_generation.load(Ordering::SeqCst) != generation {
                return;
            }
            let Some(window) = handle.get_window(WINDOW_LABEL) else {
                return;
            };
            // Absolute cap hit: dispose like a host `dispose()`.
            state.disposing.store(true, Ordering::SeqCst);
            let _ = window.close();
        });
    });
}

/// Build the native webview window with chrome + content child webviews and wire up
/// the resize listener.
///
/// Three branches:
/// - **Disposing in flight**: a `dispose()` was issued but `Destroyed` hasn't
///   fired yet. Stash the request in [`PluginState::pending_reopen`] for the
///   `CloseRequested` handler to replay against the live (cancelled-dispose)
///   webviews. See [`PluginState`].
/// - **Already open**: replay the request against the existing webviews via
///   [`apply_rewire`] — replace the current channel, eval the new init
///   script (best-effort, not document-start), re-apply initial chrome, then
///   navigate.
/// - **Fresh build**: construct the parent window, chrome + content child
///   webviews, and install the resize / close / destroy listeners.
fn present<R: Runtime>(
    app: &AppHandle<R>,
    payload: OpenRequest,
    parsed_url: Url,
) -> crate::Result<()> {
    // Close in flight: hand off to the `CloseRequested` handler, which will
    // either prevent the close + replay this request, or (if nothing else
    // intervenes) let the close land and a future fresh `open` build from
    // scratch. Always last-write-wins: a rapid double-`open` keeps the latest
    // intent. Stash the parsed `Url` alongside the payload so the replay
    // doesn't re-parse.
    if let Some(state) = app.try_state::<PluginState>() {
        if state.disposing.load(Ordering::SeqCst) {
            *lock_state(&state.pending_reopen, "pending-reopen")? = Some((payload, parsed_url));
            return Ok(());
        }
    }

    // Already open: replay channel + initScript + initial chrome + URL onto
    // the existing webviews. A second `open()` with a different channel used
    // to silently route events into the stale first channel; rewire fixes
    // that for callers that vary their per-open wiring (the sniffer's are
    // stable, so this is a no-op for it today).
    if let Some(content) = app.get_webview(CONTENT_WEBVIEW_LABEL) {
        apply_rewire(app, &content, &payload, parsed_url)?;
        return Ok(());
    }

    let init_script = payload.init_script;
    let channel = payload.native_webview_event_channel;
    // Chrome shown at first paint. The full content URL is the URL-fallback
    // value the chrome JS paints into whichever slot the caller hasn't claimed
    // (mirrors the mobile backends); the caller's initial title / subtitle /
    // message ride alongside. Baking these into the chrome HTML (rather than a
    // post-open `patch_window_text`) means the bar is correct on first paint and
    // sidesteps the race where a `patch_window_text` issued right after `open`
    // finds the chrome webview not yet built. When the URL lands in the subtitle
    // (caller claimed the title but not the subtitle) the chrome JS's
    // `reportHeight` reports the taller two-line height.
    let initial_url = parsed_url.as_str().to_owned();

    // Parent window — no built-in webview; children added below. The OS-level
    // window title (taskbar / title bar) is the caller's initial title when
    // given, else the content URL — never a hard-coded app name.
    let window_title = payload
        .initial_title
        .as_ref()
        .unwrap_or(&initial_url)
        .clone();
    // Built hidden; presented only by an explicit `show()` (navigation and
    // presentation are separate concerns). It stays hidden through `open_url`
    // so a background sniff never steals focus, and a user `hide()` keeps it
    // alive and hidden while it keeps running.
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

    // Install (first open) or reset (reopen) the native webview's per-native-webview
    // window state — chrome height, applied-layout cache, current channel, and nav
    // bookkeeping. Must precede `add_child` so the chrome's first height report
    // (fired on DOMContentLoaded) and the resize listener find the state
    // already present. The reset is load-bearing on a reopen — see
    // [`install_native_webview_state`].
    install_native_webview_state(&window, channel)?;

    // Chrome webview: HTML loaded directly via a base64 `data:` URL so the
    // chrome's DOM is in place at first paint — no `about:blank` +
    // init-script timing dance. `on_navigation` catches both action button
    // clicks (`x-nv-action://action/<name>`) and chrome-driven height
    // reports (`x-nv-action://height/<logical_px>`), returning false to
    // cancel the (would-fail) navigation.
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
        // `x-nv-action://<kind>/<value>` → `host_str` is the kind
        // (`action` / `height`), `path` is `/<value>`.
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
                // The user just went back — a forward slot now exists, so
                // enable Forward. This flag is sticky: we can't distinguish a
                // back-induced load from a fresh navigation at the Rust layer,
                // so `on_page_load` never clears it (see [`NavState`]). The
                // worst case is a Forward button left enabled after the user
                // clicks a new link, where pressing it is a no-op.
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
                // The chrome JS only ever reports a small positive px
                // height, but `parse::<f64>()` also accepts
                // `inf`/`NaN`/negatives — any of which would poison the
                // webview layout split (`logical_h - chrome_height`) with
                // no recovery path. Clamp to a finite, sane range.
                if let Ok(height) = value.parse::<f64>() {
                    if height.is_finite() && (0.0..=4096.0).contains(&height) {
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

    // Content webview: the external URL, with the caller's document-start
    // script (the browser-sniffer bundle in our usage).
    let mut content_builder =
        WebviewBuilder::new(CONTENT_WEBVIEW_LABEL, WebviewUrl::External(parsed_url));
    if let Some(script) = init_script {
        content_builder = content_builder.initialization_script(script);
    }
    // The window is built hidden and presented only by an explicit `show()` —
    // navigation (`open_url`) and presentation (`show`) are separate concerns,
    // so there is no paint-gated auto-reveal. A `show()` issued before the
    // content's first paint may briefly flash the window background on macOS
    // dark mode; that's the accepted cost of the separation.
    //
    // Update chrome back/forward enabled state on every page load. Started
    // (not Finished) so the state lands as soon as the navigation commits,
    // matching what a user would expect. We push the new state into the
    // chrome via a tiny `eval` — same path as `patchWindowText`.
    //
    // Approximation note: we can't detect "page-link nav" vs "back-induced
    // nav" at the Rust layer (Tauri's `PageLoadEvent` doesn't distinguish).
    // So `can_forward` is touched ONLY by the chrome action handler
    // (Back click → true, no clear). After a back the forward stays sticky
    // even if the user then clicks a link; clicking forward at that point
    // is a no-op (`history.forward()` past the end). The worst case is the
    // same as the previous "always enabled" behaviour, with the win that
    // `can_back` now reflects reality.
    let app_for_loads = app.clone();
    content_builder = content_builder.on_page_load(move |_webview, payload| {
        if !matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
            return;
        }
        // Keep the URL fallback in sync with this navigation — independent of
        // the nav-button bookkeeping below, so it still fires if `NavState` is
        // somehow absent. The chrome rewrites whichever slot still shows the
        // URL and no-ops once both are caller-claimed.
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

    // Start the absolute-lifetime backstop for this freshly-built native webview.
    arm_absolute_timeout(app);

    Ok(())
}

/// Per-native-webview state holding the chrome's current logical-px height —
/// (re)initialised by [`install_native_webview_state`] on each open. Read by the resize
/// listener (so window resize keeps the right vertical split) and written by
/// the chrome → Rust height-report navigation.
struct ChromeHeight(Mutex<f64>);

/// Last `(logical_w, logical_h, chrome_height)` actually applied to the child
/// webviews. `apply_chrome_height` short-circuits when the next layout matches,
/// so a no-op resize tick or a message-only `patch_window_text` (which re-reports the
/// same height) doesn't re-issue the four `set_position` / `set_size` calls
/// across both webviews.
struct AppliedLayout(Mutex<Option<(f64, f64, f64)>>);

/// Per-native-webview state holding the [`Channel<NativeWebviewEvent>`] the current
/// native webview fires events on. Set per open by [`install_native_webview_state`] and re-bindable
/// mid-native-webview: [`apply_rewire`] replaces the inner value when a second `open()`
/// lands on an existing native webview, so subsequent events (including the
/// `NativeWebviewEvent::Hidden` from a user dismissal and the
/// `NativeWebviewEvent::Disposed` from the `Destroyed` event) route to the
/// latest caller's channel.
struct CurrentChannel(Mutex<Channel<NativeWebviewEvent>>);

/// Per-native-webview state approximating the content webview's nav history for
/// back/forward button enabled state. Initialised per fresh native webview by
/// [`install_native_webview_state`]. Tauri's `Webview` exposes no `can_go_back` /
/// `can_go_forward`, so we track:
///
/// - `load_count`: increments on every content webview Started page load.
///   `canBack` = `load_count > 1`. It is NOT reset by [`apply_rewire`]: a
///   sniffer-driven navigation reuses the same content webview, whose
///   back-forward history persists across `navigate`, so Back must stay enabled
///   once ≥2 pages have loaded. (Only a brand-new native webview — fresh window + fresh
///   webview via [`install_native_webview_state`] — starts the count at 0.)
/// - `can_forward`: set `true` when the chrome's Back button fires (we know
///   the user just went back so a forward slot exists). It is **not** reset on
///   a Started load — `on_page_load` only reads it. We can't distinguish a
///   back-induced load from a fresh link-click at the Rust layer, so rather
///   than clear it on every load (which would wrongly disable Forward the
///   instant a back-navigation commits) the flag stays sticky. [`apply_rewire`]
///   clears it, since a fresh navigation truncates the forward stack. The cost
///   is a Forward button that can linger enabled after the user clicks a new
///   link, where pressing it is a harmless no-op `history.forward()` past the
///   end.
struct NavState {
    load_count: Mutex<u32>,
    can_forward: AtomicBool,
}

/// Lock a native-webview-state mutex, mapping a poisoned lock to a surfaced
/// [`crate::Error`] instead of an `unwrap` panic. A poisoned lock means another
/// thread panicked while holding it — these critical sections are trivial
/// assignments that never panic, so it is not expected to fire; surfacing it
/// lets the `open` / `present` path fail cleanly (the native webview simply doesn't
/// open) rather than taking the whole process down. Event-handler closures
/// that have no error channel to return to (resize / close / destroy) skip the
/// update on a poisoned lock instead — see their call sites.
fn lock_state<'a, T>(
    mutex: &'a Mutex<T>,
    what: &str,
) -> crate::Result<std::sync::MutexGuard<'a, T>> {
    mutex
        .lock()
        .map_err(|_| crate::Error::Internal(format!("native-webview {what} state lock poisoned")))
}

/// Install — on the first open — or reset — on a reopen — the native webview's
/// per-native-webview window state ([`ChromeHeight`], [`AppliedLayout`],
/// [`CurrentChannel`], [`NavState`]).
///
/// **Why a reset, not just `manage`**: `window.manage` writes APP-GLOBAL state
/// — a `Window`'s manager is the shared `AppManager`, not a per-window map —
/// and the underlying `StateManager::set` is **set-once**: it no-ops when the
/// type is already managed. The desktop native webview is a single reusable window
/// (label `native-webview`); once it has been closed and a later `open()`
/// builds it afresh, these four types are still managed from the previous
/// native webview, so every `manage` below silently no-ops. Left at that, the reopened
/// native webview would inherit the prior native webview's nav history (Back enabled with no
/// history), chrome height, applied-layout cache, and — for a caller that
/// varies the channel per open — route its `Closed` echo onto the stale
/// channel. So we `manage` to create the cells the first time and
/// unconditionally reset their contents on every open.
fn install_native_webview_state<R: Runtime>(
    window: &tauri::Window<R>,
    channel: Channel<NativeWebviewEvent>,
) -> crate::Result<()> {
    // `manage` returns `false` when the type was already managed (a reopen);
    // the cell then still holds the previous native webview's value, so reset it. A
    // poisoned lock here fails the open (see [`lock_state`]) rather than
    // panicking through a corrupt cell.
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

/// Replay an `open` request onto the existing chrome + content webviews:
/// replace the stored channel, eval the new init script (best-effort — see
/// caveat below), re-apply caller-supplied initial chrome, then navigate.
///
/// **InitScript caveat**: the original `init_script` was wired into the
/// content webview's `WebviewBuilder::initialization_script(...)` at
/// document-start time. Tauri offers no API to swap that hook after build,
/// so the new script lands via `eval` here — typically AFTER the page's own
/// document-start scripts, not before. Callers that rely on document-start
/// semantics for the new script should be aware. The sniffer's script is
/// stable across opens, so this lands identically to the original injection.
fn apply_rewire<R: Runtime>(
    app: &AppHandle<R>,
    content: &tauri::webview::Webview<R>,
    payload: &OpenRequest,
    parsed: Url,
) -> crate::Result<()> {
    if let Some(window) = app.get_window(WINDOW_LABEL) {
        if let Some(state) = window.try_state::<CurrentChannel>() {
            *lock_state(&state.0, "current-channel")? =
                payload.native_webview_event_channel.clone();
        }
        // A rewire navigates the SAME content webview, whose WKWebView
        // back-forward history PERSISTS across `navigate` (it pushes a new
        // entry — `loadRequest`, see wry's `load_url`). So do NOT reset
        // `load_count`: the cumulative count is what enables Back once ≥2 pages
        // have loaded, and the pending `content.navigate(parsed)` below bumps it
        // again. Resetting it here used to disable Back after every
        // sniffer-driven navigation even though the previous page was still in
        // history. Only `can_forward` is cleared — a fresh navigation truncates
        // the forward stack.
        if let Some(state) = window.try_state::<NavState>() {
            state.can_forward.store(false, Ordering::SeqCst);
        }
    }
    if let Some(script) = &payload.init_script {
        let _ = content.eval(script);
    }
    if let Some(chrome) = app.get_webview(CHROME_WEBVIEW_LABEL) {
        // A rewire is logically a fresh open, so RESET the chrome's URL-fallback
        // state (claims + slots) and seed the new URL rather than merging a
        // patch onto the prior native webview's claims. The chrome script re-applies the
        // caller's initial chrome from the same payload.
        let reset = InitialChromeState {
            url: parsed.as_str(),
            title: payload.initial_title.as_deref(),
            subtitle: payload.initial_subtitle.as_deref(),
            message: payload.initial_message.as_deref(),
        };
        if let Ok(json) = serde_json::to_string(&reset) {
            let _ = chrome.eval(format!("{CHROME_RESET_TEXT_FN}({json})"));
        }
    }
    let _ = content.navigate(parsed);
    // A reopen starts a new task clock — re-arm the absolute-lifetime backstop
    // (and supersede the prior open's timer via the generation bump).
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
        // Best-effort layout helper: skip on a poisoned lock rather than panic.
        if let Ok(mut height) = state.0.lock() {
            *height = chrome_height;
        }
    }

    // Skip the webview relayout when nothing actually moved. The resize
    // listener calls this on every resize tick and a message-only `patch_window_text`
    // re-reports the same height, so most calls land at the same geometry.
    let next = (logical_w, logical_h, chrome_height);
    if let Some(applied) = window.try_state::<AppliedLayout>() {
        // A poisoned lock just forgoes the dedup short-circuit (we fall through
        // and relayout) instead of panicking.
        if let Ok(mut guard) = applied.0.lock() {
            if *guard == Some(next) {
                return;
            }
            *guard = Some(next);
        }
    }

    if let Some(chrome) = app.get_webview(CHROME_WEBVIEW_LABEL) {
        let _ = chrome.set_position(LogicalPosition::<f64>::new(0.0, 0.0));
        let _ = chrome.set_size(LogicalSize::<f64>::new(logical_w, chrome_height));
    }
    if let Some(content) = app.get_webview(CONTENT_WEBVIEW_LABEL) {
        let _ = content.set_position(LogicalPosition::<f64>::new(0.0, chrome_height));
        let _ = content.set_size(LogicalSize::<f64>::new(
            logical_w,
            (logical_h - chrome_height).max(0.0),
        ));
    }
}

/// Window lifecycle hooks:
///
/// - **Resized**: re-lay the chrome (top, full width) and content (rest of
///   the window) so they always tile the parent exactly. Reads the
///   currently-stored chrome height from [`ChromeHeight`] so subtitle-driven
///   height changes persist across resizes.
/// - **CloseRequested**: distinguishes a user dismissal from a host
///   `dispose()`. When `disposing` is NOT set, the close came from the OS
///   titlebar X — a user dismissal — so it's cancelled (`api.prevent_close()`),
///   the window is hidden (kept alive + running), and `NativeWebviewEvent::Hidden`
///   is emitted. When `disposing` IS set, a same-tick `open_url()` may have
///   raced the dispose (its payload sits in [`PluginState::pending_reopen`]): if
///   so, cancel the dispose and replay via [`apply_rewire`]; otherwise let the
///   dispose land.
/// - **Destroyed**: fire `NativeWebviewEvent::Disposed` on the current channel
///   (the per-native-webview [`CurrentChannel`] state — re-bindable across
///   rewires). Reached by a host `dispose()`, the [`ABSOLUTE_TIMEOUT`] backstop,
///   or app teardown destroying the window on exit (the app-teardown backstop).
///   Clears [`PluginState::disposing`] so a fresh `open_url()` after this point
///   takes the build-fresh path.
///
/// `on_window_event` takes a `Fn(&WindowEvent) + Send + 'static`, so captures
/// are clones. The channel is read from the per-native-webview [`CurrentChannel`] state
/// at fire time (not captured here) so rewires take effect.
fn install_window_listeners<R: Runtime>(app: &AppHandle<R>, window: &tauri::Window<R>) {
    let app_window = app.clone();
    let window_clone = window.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::Resized(_size) => {
            // Re-use `apply_chrome_height` so resize handling and chrome's
            // own height reports go through one re-layout path. The
            // currently-stored height stays the same; only width / content
            // height change with the window.
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
            // A close that `dispose()` did NOT initiate is a user dismissal (the
            // OS titlebar X). Per the hide/dispose split a user dismissal HIDES
            // — it keeps the native webview alive and running — so cancel the
            // teardown, hide the window, and emit `Hidden`. Only an explicit
            // `dispose()` (which sets `disposing`) is allowed to tear the window
            // down. (App teardown destroys windows through a separate path that
            // bypasses `prevent_close`, so the app-teardown backstop still
            // reaches `Destroyed` → `Disposed`.)
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
            // `dispose()` is in flight. The race: a same-tick `open_url()`
            // stashed its payload into `pending_reopen` (see [`present`]). Take
            // it now: `Some` → cancel this dispose and replay the open against
            // the live webviews; `None` → let the dispose land (→ `Destroyed`).
            // Either way `disposing` is cleared so subsequent calls aren't stuck
            // in the deferral branch.
            let pending = match state.pending_reopen.lock() {
                Ok(mut guard) => guard.take(),
                // Poisoned lock: we can't safely consult the deferral slot, so
                // let the dispose proceed (no replay) rather than panicking.
                Err(_) => return,
            };
            let Some((payload, parsed)) = pending else {
                return;
            };
            api.prevent_close();
            state.disposing.store(false, Ordering::SeqCst);
            // Replay the deferred open against the live (cancelled-close)
            // webviews. The parsed `Url` rode along in `pending_reopen`, so
            // there's no re-parse here. Skip if the content webview is gone
            // (shouldn't happen — CloseRequested fires before teardown).
            let Some(content) = app_window.get_webview(CONTENT_WEBVIEW_LABEL) else {
                return;
            };
            // Best-effort in an event handler: a poisoned state lock can't be
            // surfaced to a caller here, so a failed rewire leaves the native webview
            // as-is rather than panicking.
            let _ = apply_rewire(&app_window, &content, &payload, parsed);
        }
        WindowEvent::Destroyed => {
            // The window was torn down — a host `dispose()`, or the app teardown
            // destroying it on exit (the app-teardown backstop). Notify the
            // *current* caller's channel that the native webview is gone — read
            // from the per-native-webview `CurrentChannel` state so a rewire
            // before the dispose lands routes the event to the latest caller.
            // Errors are swallowed: the window is gone either way, and the
            // channel send is the only way to surface the teardown to the host.
            if let Some(state) = window_clone.try_state::<CurrentChannel>() {
                if let Ok(channel) = state.0.lock() {
                    let _ = channel.send(NativeWebviewEvent::Disposed);
                }
            }
            if let Some(state) = app_window.try_state::<PluginState>() {
                state.disposing.store(false, Ordering::SeqCst);
                // Drop any payload that raced a close-that-actually-landed.
                // The caller's `open` resolved `opened: true`, but the
                // window died before `CloseRequested` saw the payload — so
                // a fresh `open()` would have to be issued to recover. This
                // is a tiny lossy edge for callers issuing close+open from
                // OFF the main thread (the listener-thread case has
                // `present()` run synchronously before the close lands).
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
}
