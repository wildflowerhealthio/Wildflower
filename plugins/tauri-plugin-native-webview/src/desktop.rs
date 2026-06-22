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

use std::sync::Mutex;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::de::DeserializeOwned;
use tauri::{
    ipc::Channel, plugin::PluginApi, webview::WebviewBuilder, window::WindowBuilder, AppHandle,
    Listener, LogicalPosition, LogicalSize, Manager, Runtime, WebviewUrl, WindowEvent,
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
    <button id="back" aria-label="Back">&#x2039;</button>
    <button id="forward" aria-label="Forward">&#x203A;</button>
    <button id="refresh" aria-label="Refresh">&#x21BB;</button>
  </div>
  <div class="title-stack">
    <div id="title">__INITIAL_TITLE__</div>
    <div id="subtitle"></div>
  </div>
  <div id="message"></div>
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
/// host plain-text-substituted, base64-encoded into a `data:text/html;base64,…`
/// URL so `Url::parse` accepts the document verbatim.
///
/// Escaping: `initial_host` is HTML-escaped before substitution. The host
/// comes from `url::Url::host_str` so it's already sanitised against most
/// payloads, but `<` / `>` / `&` in pathological hosts (e.g. attacker-
/// controlled servers behind the popup) could otherwise inject markup.
fn build_chrome_data_url(initial_host: &str) -> Url {
    let escaped_host = html_escape(initial_host);
    let html = CHROME_HTML_TEMPLATE.replace("__INITIAL_TITLE__", &escaped_host);
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
    Ok(NativeWebview(app.clone()))
}

/// Desktop handle to the native-webview plugin.
pub struct NativeWebview<R: Runtime>(AppHandle<R>);

impl<R: Runtime> NativeWebview<R> {
    /// Present the external URL in a popup `Window` with chrome + content
    /// child webviews. Window creation is marshalled onto the main thread
    /// (required on macOS). Build failures are logged best-effort, not
    /// returned, matching the trial-level desktop posture.
    pub fn open(&self, payload: OpenRequest) -> crate::Result<()> {
        let app = self.0.clone();
        self.0
            .run_on_main_thread(move || {
                if let Err(error) = present(&app, payload) {
                    eprintln!("native-webview: failed to open desktop popup: {error}");
                }
            })
            .map_err(|error| crate::Error::Internal(error.to_string()))?;
        Ok(())
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
    pub fn close(&self) -> crate::Result<()> {
        let Some(window) = self.0.get_window(WINDOW_LABEL) else {
            return Ok(());
        };
        window
            .close()
            .map_err(|error| crate::Error::Internal(error.to_string()))?;
        Ok(())
    }
}

/// Build the popup window with chrome + content child webviews and wire up
/// the resize listener. Idempotent: if the popup is already up, navigates
/// the content webview to the new URL in place (and discards the new
/// `init_script` / `channel` — the existing popup keeps its original
/// wiring, matching the mobile dedupe behaviour).
fn present<R: Runtime>(app: &AppHandle<R>, payload: OpenRequest) -> crate::Result<()> {
    let parsed = Url::parse(&payload.url)
        .map_err(|error| crate::Error::Internal(format!("invalid URL {}: {error}", payload.url)))?;

    // Already open: navigate content in place; chrome stays.
    if let Some(content) = app.get_webview(CONTENT_WEBVIEW_LABEL) {
        content
            .navigate(parsed)
            .map_err(|error| crate::Error::Internal(error.to_string()))?;
        return Ok(());
    }

    let init_script = payload.init_script;
    let channel = payload.channel;
    let initial_host = parsed.host_str().unwrap_or("").to_owned();

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

    // Chrome webview: HTML loaded directly via a base64 `data:` URL so the
    // chrome's DOM is in place at first paint — no `about:blank` +
    // init-script timing dance. `on_navigation` catches both action button
    // clicks (`x-nv-action://action/<name>`) and chrome-driven height
    // reports (`x-nv-action://height/<logical_px>`), returning false to
    // cancel the (would-fail) navigation.
    let chrome_url = build_chrome_data_url(&initial_host);
    let app_for_actions = app.clone();
    let window_for_actions = window.clone();
    let chrome_builder = WebviewBuilder::new(CHROME_WEBVIEW_LABEL, WebviewUrl::External(chrome_url))
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
                    let _ = content.eval(script);
                }
                Some("height") => {
                    if let Ok(height) = value.parse::<f64>() {
                        apply_chrome_height(&app_for_actions, &window_for_actions, height);
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

    install_window_listeners(app, &window, channel);

    Ok(())
}

/// Window-managed state holding the chrome's current logical-px height.
/// Read by the resize listener (so window resize keeps the right vertical
/// split) and written by the chrome → Rust height-report navigation.
struct ChromeHeight(Mutex<f64>);

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
/// - **Destroyed**: fire `PopupEvent::Closed` on the caller's channel. The
///   user dismisses the desktop popup via the OS window X (the chrome bar
///   has no Close button); without this hook the sniffer's collector would
///   idle-timeout waiting for `SniffingComplete`. Matches the mobile path
///   where the plugin's native chrome Close button fires `Closed` after
///   the dismiss animation.
///
/// `on_window_event` takes a `Fn(&WindowEvent) + Send + 'static`, so captures
/// are clones. The channel itself is `Arc`-backed `Clone`, so it cheaply
/// hops into the closure.
fn install_window_listeners<R: Runtime>(
    app: &AppHandle<R>,
    window: &tauri::Window<R>,
    channel: Channel<PopupEvent>,
) {
    /// Future-proofing: if we ever attach `app.listen` ids that need to be
    /// unregistered on close, drain them from here. Today's design uses
    /// `on_navigation` for chrome → Rust, which is a per-webview hook that
    /// goes away with the webview itself, so the slot is empty.
    struct ListenerIds(Mutex<Vec<tauri::EventId>>);
    window.manage(ListenerIds(Mutex::new(Vec::new())));

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
        WindowEvent::Destroyed => {
            // Notify the caller's channel handler that the popup has gone
            // away. Errors are swallowed — the window is gone either way,
            // and the channel send is the only mechanism we have to surface
            // the dismissal to the host.
            let _ = channel.send(PopupEvent::Closed);
            if let Some(ids) = window_clone.try_state::<ListenerIds>() {
                for id in ids.0.lock().unwrap().drain(..) {
                    app_window.unlisten(id);
                }
            }
        }
        _ => {}
    });
}
