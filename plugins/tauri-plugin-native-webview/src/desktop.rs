//! Desktop backend.
//!
//! Tauri's multi-webview-per-window API (`Window::add_child`, gated behind the
//! `unstable` feature) lets us mirror the iOS/Android native popup layout on
//! desktop: a chrome bar (URL host / subtitle / message + back / forward /
//! refresh) anchored at the top, and the external content webview below.
//! The two webviews share the same parent `Window` so the OS treats them as
//! one popup; resize is handled by [`on_window_event`] which re-lays the
//! children on every resize tick.
//!
//! ## Chrome ↔ Rust IPC
//!
//! The chrome webview loads `about:blank` with an init script that builds its
//! DOM. Communication with Rust stays inside the webview's own
//! `on_navigation` hook — no `__TAURI__` event bus access required:
//!
//! - **Chrome → Rust**: button clicks set `window.location.href` to
//!   `x-nv-action://action/<back|forward|refresh>`. Rust's `on_navigation`
//!   matches the custom scheme, dispatches a `history.*` / `location.reload`
//!   `eval` on the content webview, and returns `false` to cancel the actual
//!   navigation (the unregistered scheme would error anyway). The cancel is
//!   the load guard; the dispatch is the side effect we wanted.
//!
//! - **Rust → Chrome**: `webview.eval("window.__nativeWebviewSetChrome({...})")`.
//!   `eval` is Rust-initiated and bypasses capability checks, so the chrome's
//!   `about:blank` origin can be entirely outside the capability allowlist.
//!
//! Caveat vs. mobile: both webviews are Tauri webviews here, so the content
//! one still has `window.__TAURI__`. The host app's capability JSON scopes it
//! to just the event bus + log (matching the pre-multi-webview posture). The
//! chrome webview doesn't appear in any capability — it doesn't need to,
//! since it uses no Tauri commands.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::de::DeserializeOwned;
use tauri::{
    ipc::Channel, plugin::PluginApi, webview::WebviewBuilder, window::WindowBuilder, AppHandle,
    LogicalPosition, LogicalSize, Manager, Runtime, WebviewUrl, WindowEvent,
};
use url::Url;

use crate::models::{OpenRequest, PopupEvent, SendRequest, SetChromeRequest};

/// Label for the desktop native-webview parent window.
/// `capabilities/native-webview-window.json` keys on it to scope the grant.
const WINDOW_LABEL: &str = "native-webview";
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
const CHROME_STATE_FN: &str = "window.__nativeWebviewSetChrome";

/// Rust → chrome nav-state push for back/forward button enabled state.
/// Tracked Rust-side because Tauri's `Webview` API exposes no
/// `can_go_back` / `can_go_forward` predicates — we approximate from the
/// `on_page_load` hook + chrome action interception (back click flips
/// `canForward` on).
const CHROME_NAV_STATE_FN: &str = "window.__nativeWebviewSetNavState";

/// Full HTML document the chrome webview loads as its source — base64-encoded
/// into a `data:text/html;base64,…` URL so quotes / angle-brackets / spaces
/// don't break `Url::parse`. `__INITIAL_TITLE__` is plain-text-replaced at
/// build time with the URL host so the chrome's first paint already has the
/// title set (no `about:blank` + init-script race against `DOMContentLoaded`).
const CHROME_HTML_TEMPLATE: &str = r#"<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; height: 100%; }
  body {
    background: #14161C;
    color: #f4f4f5;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    /* Two-column flex: nav left, message right. The title-stack is
       absolutely positioned over the body's centre so it tracks the
       window, not the available space between nav and message (those
       siblings have asymmetric widths and would otherwise pull the
       title off-centre). Asymmetric vertical padding — a bit more on
       the bottom — gives the bar visual breathing room against the
       content webview below. */
    position: relative;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px 12px;
    user-select: none;
  }
  button {
    background: transparent;
    color: inherit;
    border: 0;
    border-radius: 6px;
    padding: 6px 8px;
    cursor: pointer;
    font-size: 18px;
    line-height: 1;
    min-width: 32px;
  }
  button:hover:not(:disabled) { background: rgba(255,255,255,0.1); }
  button:disabled { opacity: 0.4; cursor: default; }
  .nav { display: flex; gap: 2px; flex-shrink: 0; }
  .title-stack {
    position: absolute;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    display: flex;
    flex-direction: column;
    align-items: center;
    /* Cap so a long host doesn't bleed into the nav / message regions —
       60% leaves ~20% on each side for siblings before the title clips. */
    max-width: 60%;
    gap: 2px;
    /* Click-through: the title is a label, not an interactive surface;
       sibling buttons should still receive clicks if they overlap. */
    pointer-events: none;
  }
  #title {
    font-size: 14px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
  }
  #subtitle {
    font-size: 11px;
    color: #A0A4AF;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
  }
  #subtitle:empty { display: none; }
  #message {
    font-size: 12px;
    color: #A0A4AF;
    flex-shrink: 0;
    max-width: 30%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  #message:empty { display: none; }
</style>
</head>
<body>
  <div class="nav">
    <button id="back" aria-label="Back" disabled>&#x2039;</button>
    <button id="forward" aria-label="Forward" disabled>&#x203A;</button>
    <button id="refresh" aria-label="Refresh">&#x21BB;</button>
  </div>
  <div class="title-stack">
    <div id="title">__INITIAL_TITLE__</div>
    <div id="subtitle">__INITIAL_SUBTITLE__</div>
  </div>
  <div id="message">__INITIAL_MESSAGE__</div>
<script>
(function() {
  // Chrome → Rust: bounce through a fake custom-scheme nav.
  // `on_navigation` on the Rust side intercepts, dispatches the action
  // onto the content webview, and returns false so the actual nav is
  // cancelled.
  var trigger = function(action) {
    window.location.href = 'x-nv-action://action/' + encodeURIComponent(action);
  };
  document.getElementById('back').addEventListener('click', function() { trigger('back'); });
  document.getElementById('forward').addEventListener('click', function() { trigger('forward'); });
  document.getElementById('refresh').addEventListener('click', function() { trigger('refresh'); });

  // Tell Rust how tall this chrome bar wants to be. Subtitle-present
  // pushes the bar from a compact title-only height up to a two-line
  // height; Rust resizes the chrome + content webviews to match. Called
  // on DOM ready and again whenever state changes, so the bar stays
  // tightly fit to its current content. Constants here are paired with
  // `CHROME_HEIGHT_BASE` on the Rust side — drift would either clip
  // content or leave a gap above the content webview.
  var reportHeight = function() {
    var hasSubtitle = !!document.getElementById('subtitle').textContent;
    var height = hasSubtitle ? 68 : 52;
    window.location.href = 'x-nv-action://height/' + height;
  };

  // Rust pushes state by calling this via `webview.eval(...)`. Each call
  // merges only the fields present, matching `SetChromeRequest`'s
  // `Option<String>` semantics (None = no change, "" = clear, set otherwise).
  window.__nativeWebviewSetChrome = function(state) {
    if (!state) return;
    if (state.title != null) document.getElementById('title').textContent = state.title;
    if (state.subtitle != null) document.getElementById('subtitle').textContent = state.subtitle;
    if (state.message != null) document.getElementById('message').textContent = state.message;
    reportHeight();
  };

  // Rust pushes back/forward enabled state via this global. Tauri's Webview
  // Rust API exposes no `can_go_back` / `can_go_forward` predicates, so we
  // track navigation count + last action in Rust and call this on each page
  // load. `null` for either field = leave as-is.
  window.__nativeWebviewSetNavState = function(state) {
    if (!state) return;
    if (state.canBack != null) document.getElementById('back').disabled = !state.canBack;
    if (state.canForward != null) document.getElementById('forward').disabled = !state.canForward;
  };

  // Initial height report — covers the title-on-open case before
  // `setChrome` lands and ensures Rust's stored height matches whatever
  // the chrome JS thinks it wants.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', reportHeight);
  } else {
    reportHeight();
  }
})();
</script>
</body>
</html>
"#;

/// Build the chrome webview's source URL — the full HTML doc above with the
/// initial title / subtitle / message plain-text-substituted, base64-encoded
/// into a `data:text/html;base64,…` URL so `Url::parse` accepts the document
/// verbatim.
///
/// Escaping: each value is HTML-escaped before substitution. The title is
/// typically the `url::Url::host_str` (already sanitised against most
/// payloads), but `<` / `>` / `&` in a pathological host or a caller-supplied
/// subtitle/message could otherwise inject markup into the chrome.
fn build_chrome_data_url(title: &str, subtitle: &str, message: &str) -> Url {
    let html = CHROME_HTML_TEMPLATE
        .replace("__INITIAL_TITLE__", &html_escape(title))
        .replace("__INITIAL_SUBTITLE__", &html_escape(subtitle))
        .replace("__INITIAL_MESSAGE__", &html_escape(message));
    let encoded = BASE64.encode(html.as_bytes());
    let url_str = format!("data:text/html;base64,{encoded}");
    Url::parse(&url_str).expect("data URL parses")
}

/// Minimal HTML escape — covers the chars that change DOM structure if
/// dropped raw into innerHTML / a static template. We don't need a full
/// HTML attribute / JS escape here because the substitution lands inside a
/// `<div>` text node only.
fn html_escape(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Build the desktop backend.
pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<NativeWebview<R>> {
    // App-managed coordination between `close()`, `present()`, and the popup
    // window's `CloseRequested` handler — see [`PluginState`] for the race story.
    app.manage(PluginState {
        closing: AtomicBool::new(false),
        pending_reopen: Mutex::new(None),
    });
    Ok(NativeWebview(app.clone()))
}

/// App-managed coordination state for the close/reopen race fix.
///
/// A "switch demos" sequence emits `SniffingComplete` → `close()` → and then
/// `RequestSniffableWebView` → `open()` on the same main-thread bridge listener
/// tick. `WebviewWindow::close()` only *queues* a `WindowMessage::Close` via the
/// runtime's proxy (see `runtime-wry/lib.rs::WindowDispatcher::close`) and
/// returns immediately, so the subsequent same-tick `present()` runs *before*
/// the `CloseRequested` event fires. Without coordination, `present()` finds
/// the doomed window via `get_webview` and navigates it in place — then the
/// queued close destroys the popup and the user sees nothing.
///
/// The fix is to make the close cancellable: `close()` flips `closing` to
/// `true` before asking the runtime to close, `present()` stashes its
/// `OpenRequest` payload in `pending_reopen` when it sees `closing`, and the
/// window's `CloseRequested` handler reads `pending_reopen` to either
/// `prevent_close()` + re-wire (channel + initScript + chrome + URL) the
/// existing webviews, or let the close proceed when nothing is pending.
struct PluginState {
    /// `true` between the `close()` call and the `Destroyed` event that
    /// follows a non-cancelled close. Read by `present()` to defer building or
    /// re-wiring against a doomed window.
    closing: AtomicBool,
    /// The `OpenRequest` `present()` deferred while `closing == true`. The
    /// `CloseRequested` handler takes it (`Option::take`) — if `Some`, it
    /// cancels the close and replays the request against the existing
    /// webviews; if `None`, the close proceeds.
    pending_reopen: Mutex<Option<OpenRequest>>,
}

/// Desktop handle to the native-webview plugin.
pub struct NativeWebview<R: Runtime>(AppHandle<R>);

impl<R: Runtime> NativeWebview<R> {
    /// Present the external URL in a popup `Window` with chrome + content
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
    pub fn open(&self, payload: OpenRequest) -> crate::Result<()> {
        Url::parse(&payload.url).map_err(|error| {
            crate::Error::Internal(format!("invalid URL {}: {error}", payload.url))
        })?;
        let app = self.0.clone();
        let (tx, rx) = std::sync::mpsc::sync_channel::<crate::Result<()>>(1);
        self.0
            .run_on_main_thread(move || {
                // Best-effort send: rx is dropped only if `run_on_main_thread`
                // returned an error AND the caller exited before we could
                // send — in which case nobody is reading anyway.
                let _ = tx.send(present(&app, payload));
            })
            .map_err(|error| crate::Error::Internal(error.to_string()))?;
        rx.recv()
            .map_err(|error| crate::Error::Internal(error.to_string()))?
    }

    /// Evaluate JS in the content webview. Returns an error if no popup is
    /// open (matches the mobile contract — `send` is content-bound, so
    /// there's no graceful fallback).
    pub fn send(&self, payload: SendRequest) -> crate::Result<()> {
        let content = self
            .0
            .get_webview(CONTENT_WEBVIEW_LABEL)
            .ok_or_else(|| crate::Error::Internal("no native-webview popup open".to_owned()))?;
        content
            .eval(&payload.script)
            .map_err(|error| crate::Error::Internal(error.to_string()))?;
        Ok(())
    }

    /// Push title / subtitle / message into the chrome by `eval`-ing the
    /// init-script-defined `__nativeWebviewSetChrome` global with a JSON
    /// payload of only the fields the caller wants to change. The JS side
    /// applies non-`null` fields and leaves the rest untouched — matching
    /// the iOS / Android `setChrome` semantics.
    ///
    /// No-op if no popup is open. Returns `Ok` either way so callers can
    /// fire speculatively across the popup lifecycle (mirrors mobile
    /// `{set: false}` on a closed popup).
    pub fn set_chrome(&self, payload: SetChromeRequest) -> crate::Result<()> {
        let Some(chrome) = self.0.get_webview(CHROME_WEBVIEW_LABEL) else {
            return Ok(());
        };
        // Serialise the request directly — the wire camelCase keys
        // (`title` / `subtitle` / `message`) match what
        // `__nativeWebviewSetChrome` reads.
        let json = serde_json::to_string(&payload)
            .map_err(|error| crate::Error::Internal(error.to_string()))?;
        chrome
            .eval(format!("{CHROME_STATE_FN}({json})"))
            .map_err(|error| crate::Error::Internal(error.to_string()))?;
        Ok(())
    }

    /// Dismiss the popup window. Idempotent — no-op if not open.
    ///
    /// Flips [`PluginState::closing`] before asking the runtime to close so a
    /// same-tick `open()` that races this close lands in the deferral branch
    /// of [`present`] (queued into `pending_reopen`) rather than navigating
    /// the doomed window. See [`PluginState`] for the full race story.
    pub fn close(&self) -> crate::Result<()> {
        let Some(window) = self.0.get_window(WINDOW_LABEL) else {
            return Ok(());
        };
        if let Some(state) = self.0.try_state::<PluginState>() {
            state.closing.store(true, Ordering::SeqCst);
        }
        window
            .close()
            .map_err(|error| crate::Error::Internal(error.to_string()))?;
        Ok(())
    }
}

/// Build the popup window with chrome + content child webviews and wire up
/// the resize listener.
///
/// Three branches:
/// - **Closing in flight**: a `close()` was issued but `Destroyed` hasn't
///   fired yet. Stash the request in [`PluginState::pending_reopen`] for the
///   `CloseRequested` handler to replay against the live (cancelled-close)
///   webviews. See [`PluginState`].
/// - **Already open**: replay the request against the existing webviews via
///   [`apply_rewire`] — replace the current channel, eval the new init
///   script (best-effort, not document-start), re-apply initial chrome, then
///   navigate.
/// - **Fresh build**: construct the parent window, chrome + content child
///   webviews, and install the resize / close / destroy listeners.
fn present<R: Runtime>(app: &AppHandle<R>, payload: OpenRequest) -> crate::Result<()> {
    let parsed = Url::parse(&payload.url)
        .map_err(|error| crate::Error::Internal(format!("invalid URL {}: {error}", payload.url)))?;

    // Close in flight: hand off to the `CloseRequested` handler, which will
    // either prevent the close + replay this request, or (if nothing else
    // intervenes) let the close land and a future fresh `open` build from
    // scratch. Always last-write-wins: a rapid double-`open` keeps the latest
    // intent.
    if let Some(state) = app.try_state::<PluginState>() {
        if state.closing.load(Ordering::SeqCst) {
            *state.pending_reopen.lock().unwrap() = Some(payload);
            return Ok(());
        }
    }

    // Already open: replay channel + initScript + initial chrome + URL onto
    // the existing webviews. A second `open()` with a different channel used
    // to silently route events into the stale first channel; rewire fixes
    // that for callers that vary their per-open wiring (the sniffer's are
    // stable, so this is a no-op for it today).
    if let Some(content) = app.get_webview(CONTENT_WEBVIEW_LABEL) {
        apply_rewire(app, &content, &payload, parsed);
        return Ok(());
    }

    let init_script = payload.init_script;
    let channel = payload.channel;
    // Chrome shown at first paint: caller-supplied title / subtitle / message,
    // with the URL host as the title fallback. Baking these into the chrome
    // HTML (rather than a post-open `set_chrome`) means the bar is correct on
    // first paint and sidesteps the race where a `set_chrome` issued right
    // after `open` finds the chrome webview not yet built. The subtitle drives
    // the initial bar height: the chrome JS's `reportHeight` on DOMContentLoaded
    // sees a non-empty `#subtitle` and reports the taller two-line height.
    let initial_host = parsed.host_str().unwrap_or("").to_owned();
    let title = payload.initial_title.unwrap_or(initial_host);
    let subtitle = payload.initial_subtitle.unwrap_or_default();
    let message = payload.initial_message.unwrap_or_default();

    // Parent window — no built-in webview; children added below.
    let window = WindowBuilder::new(app, WINDOW_LABEL)
        .title("Wildflower")
        .inner_size(900.0, 700.0)
        .resizable(true)
        .build()
        .map_err(|error| crate::Error::Internal(error.to_string()))?;

    let window_size = window
        .inner_size()
        .map_err(|error| crate::Error::Internal(error.to_string()))?;
    let scale = window
        .scale_factor()
        .map_err(|error| crate::Error::Internal(error.to_string()))?;
    let logical_width = window_size.width as f64 / scale;
    let logical_height = window_size.height as f64 / scale;

    // Stash the current chrome height on the window's typemap before adding
    // children so the on_navigation handler (chrome → Rust height reports)
    // and the resize listener can both consult / mutate the same source of
    // truth. Initial value is `CHROME_HEIGHT_BASE` (title-only); chrome JS
    // re-reports immediately on DOMContentLoaded, so the first set_chrome
    // with a subtitle bumps it to `CHROME_HEIGHT_WITH_SUBTITLE`.
    window.manage(ChromeHeight(Mutex::new(CHROME_HEIGHT_BASE)));
    window.manage(AppliedLayout(Mutex::new(None)));
    // Stash the caller's channel on the window's typemap so the
    // `Destroyed` handler can fire `PopupEvent::Closed` against the current
    // channel — not the one captured at install time. A subsequent `open()`
    // with a different channel replaces this entry via [`apply_rewire`], so
    // events route to the latest caller across rewires.
    window.manage(CurrentChannel(Mutex::new(channel)));
    // Nav state for back/forward enabled bookkeeping — see [`NavState`].
    window.manage(NavState {
        load_count: Mutex::new(0),
        can_forward: AtomicBool::new(false),
    });

    // Chrome webview: HTML loaded directly via a base64 `data:` URL so the
    // chrome's DOM is in place at first paint — no `about:blank` +
    // init-script timing dance. `on_navigation` catches both action button
    // clicks (`x-nv-action://action/<name>`) and chrome-driven height
    // reports (`x-nv-action://height/<logical_px>`), returning false to
    // cancel the (would-fail) navigation.
    let chrome_url = build_chrome_data_url(&title, &subtitle, &message);
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
                // The user just went back — a forward slot now exists.
                // The next page-load Started event resets this if it's a
                // non-back navigation (we can't distinguish at the Rust
                // layer, so any new load conservatively clears forward).
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
    window
        .add_child(
            chrome_builder,
            LogicalPosition::<f64>::new(0.0, 0.0),
            LogicalSize::<f64>::new(logical_width, CHROME_HEIGHT_BASE),
        )
        .map_err(|error| crate::Error::Internal(error.to_string()))?;

    // Content webview: the external URL, with the caller's document-start
    // script (the browser-sniffer bundle in our usage).
    let mut content_builder =
        WebviewBuilder::new(CONTENT_WEBVIEW_LABEL, WebviewUrl::External(parsed));
    if let Some(script) = init_script {
        content_builder = content_builder.initialization_script(script);
    }
    // Update chrome back/forward enabled state on every page load. Started
    // (not Finished) so the state lands as soon as the navigation commits,
    // matching what a user would expect. We push the new state into the
    // chrome via a tiny `eval` — same path as `setChrome`.
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
        let Some(window) = app_for_loads.get_window(WINDOW_LABEL) else {
            return;
        };
        let Some(state) = window.try_state::<NavState>() else {
            return;
        };
        let new_count = {
            let mut count = state.load_count.lock().unwrap();
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
    window
        .add_child(
            content_builder,
            LogicalPosition::<f64>::new(0.0, CHROME_HEIGHT_BASE),
            LogicalSize::<f64>::new(
                logical_width,
                (logical_height - CHROME_HEIGHT_BASE).max(0.0),
            ),
        )
        .map_err(|error| crate::Error::Internal(error.to_string()))?;

    install_window_listeners(app, &window);

    Ok(())
}

/// Window-managed state holding the chrome's current logical-px height.
/// Read by the resize listener (so window resize keeps the right vertical
/// split) and written by the chrome → Rust height-report navigation.
struct ChromeHeight(Mutex<f64>);

/// Last `(logical_w, logical_h, chrome_height)` actually applied to the child
/// webviews. `apply_chrome_height` short-circuits when the next layout matches,
/// so a no-op resize tick or a message-only `set_chrome` (which re-reports the
/// same height) doesn't re-issue the four `set_position` / `set_size` calls
/// across both webviews.
struct AppliedLayout(Mutex<Option<(f64, f64, f64)>>);

/// Window-managed state holding the [`Channel<PopupEvent>`] the current popup
/// fires events on. Re-bindable: [`apply_rewire`] replaces the inner value
/// when a second `open()` lands on an existing popup, so subsequent events
/// (including the eventual `PopupEvent::Closed` from the `Destroyed` event)
/// route to the latest caller's channel.
struct CurrentChannel(Mutex<Channel<PopupEvent>>);

/// Window-managed state approximating the content webview's nav history for
/// back/forward button enabled state. Tauri's `Webview` exposes no
/// `can_go_back` / `can_go_forward`, so we track:
///
/// - `load_count`: increments on every content webview Started page load.
///   `canBack` = `load_count > 1`.
/// - `can_forward`: set `true` when the chrome's Back button fires (we know
///   the user just went back so a forward slot exists); reset `false` on
///   each Started load (any non-back navigation invalidates the forward slot
///   — we don't distinguish back/non-back at the Rust layer, so this is
///   conservative).
///
/// Reset on [`apply_rewire`] so a "second open" navigation starts fresh
/// (you can't go back to the previous popup's history).
struct NavState {
    load_count: Mutex<u32>,
    can_forward: AtomicBool,
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
) {
    if let Some(window) = app.get_window(WINDOW_LABEL) {
        if let Some(state) = window.try_state::<CurrentChannel>() {
            *state.0.lock().unwrap() = payload.channel.clone();
        }
        // Reset nav history bookkeeping — a rewire is logically a fresh
        // "open" of the popup, so back/forward should start disabled. The
        // pending `content.navigate(parsed)` call below fires a Started
        // page load that bumps `load_count` back to 1.
        if let Some(state) = window.try_state::<NavState>() {
            *state.load_count.lock().unwrap() = 0;
            state.can_forward.store(false, Ordering::SeqCst);
        }
    }
    if let Some(script) = &payload.init_script {
        let _ = content.eval(script);
    }
    if let Some(chrome) = app.get_webview(CHROME_WEBVIEW_LABEL) {
        let chrome_payload = SetChromeRequest {
            title: payload.initial_title.clone(),
            subtitle: payload.initial_subtitle.clone(),
            message: payload.initial_message.clone(),
        };
        if let Ok(json) = serde_json::to_string(&chrome_payload) {
            let _ = chrome.eval(format!("{CHROME_STATE_FN}({json})"));
        }
    }
    let _ = content.navigate(parsed);
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
        *state.0.lock().unwrap() = chrome_height;
    }

    // Skip the webview relayout when nothing actually moved. The resize
    // listener calls this on every resize tick and a message-only `set_chrome`
    // re-reports the same height, so most calls land at the same geometry.
    let next = (logical_w, logical_h, chrome_height);
    if let Some(applied) = window.try_state::<AppliedLayout>() {
        let mut guard = applied.0.lock().unwrap();
        if *guard == Some(next) {
            return;
        }
        *guard = Some(next);
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
/// - **CloseRequested**: if a `present()` raced this close (its payload sits
///   in [`PluginState::pending_reopen`]), cancel the close via
///   `api.prevent_close()` and replay the payload via [`apply_rewire`] —
///   the popup stays alive, the user sees a navigation instead of a close +
///   reopen flicker. Otherwise let the close proceed.
/// - **Destroyed**: fire `PopupEvent::Closed` on the current channel
///   ([`CurrentChannel`] in the window's typemap — re-bindable across
///   rewires). The user dismisses the desktop popup via the OS window X (the
///   chrome bar has no Close button); without this hook the sniffer's
///   collector would idle-timeout waiting for `SniffingComplete`. Matches the
///   mobile path where the plugin's native chrome Close button fires `Closed`
///   after the dismiss animation. Also clears [`PluginState::closing`] —
///   a fresh `open()` after this point takes the build-fresh path.
///
/// `on_window_event` takes a `Fn(&WindowEvent) + Send + 'static`, so captures
/// are clones. The channel is read from window-managed state at fire time
/// (not captured here) so rewires take effect.
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
                .map_or(CHROME_HEIGHT_BASE, |s| *s.0.lock().unwrap());
            apply_chrome_height(&app_window, &window_clone, height);
        }
        WindowEvent::CloseRequested { api, .. } => {
            // The race: `close()` was issued, then a same-tick `open()`
            // stashed its payload into `pending_reopen` (see
            // [`present`]). Take it now: `Some` means "cancel this close
            // and replay the open against the live webviews"; `None`
            // means "let the close land". Either way, `closing` is
            // cleared so subsequent calls aren't stuck in the deferral
            // branch.
            let Some(state) = app_window.try_state::<PluginState>() else {
                return;
            };
            let pending = state.pending_reopen.lock().unwrap().take();
            let Some(payload) = pending else {
                return;
            };
            api.prevent_close();
            state.closing.store(false, Ordering::SeqCst);
            // Replay the deferred open. Skip on either of: content webview
            // gone (shouldn't happen — CloseRequested fires before
            // teardown), or unparseable URL (already validated in the
            // command layer, defensive only).
            let Some(content) = app_window.get_webview(CONTENT_WEBVIEW_LABEL) else {
                return;
            };
            let Ok(parsed) = Url::parse(&payload.url) else {
                return;
            };
            apply_rewire(&app_window, &content, &payload, parsed);
        }
        WindowEvent::Destroyed => {
            // Notify the *current* caller's channel handler that the popup
            // has gone away — read from the window's typemap so a rewire
            // before the close lands routes the event to the latest caller.
            // Errors are swallowed: the window is gone either way, and the
            // channel send is the only way to surface dismissal to the host.
            if let Some(state) = window_clone.try_state::<CurrentChannel>() {
                let _ = state.0.lock().unwrap().send(PopupEvent::Closed);
            }
            if let Some(state) = app_window.try_state::<PluginState>() {
                state.closing.store(false, Ordering::SeqCst);
                // Drop any payload that raced a close-that-actually-landed.
                // The caller's `open` resolved `opened: true`, but the
                // window died before `CloseRequested` saw the payload — so
                // a fresh `open()` would have to be issued to recover. This
                // is a tiny lossy edge for callers issuing close+open from
                // OFF the main thread (the listener-thread case has
                // `present()` run synchronously before the close lands).
                *state.pending_reopen.lock().unwrap() = None;
            }
        }
        _ => {}
    });
}
