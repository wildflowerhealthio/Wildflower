//! The chrome bar: its `data:`-HTML document + build, the `x-nv-action` action
//! scheme handler (chrome → Rust IPC), and the chrome/content layout split. See
//! the [`super`] module docs § "Chrome ↔ Rust IPC" for the transport rationale.

use std::sync::atomic::Ordering;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use tauri::plugin::Builder as PluginBuilder;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Runtime, Window};
use url::Url;

use super::labels::{chrome_label, content_label, id_from_chrome_label, window_label};
use super::state::instance_state;

/// Logical-px chrome bar height in its compact state (title + nav buttons, no
/// subtitle), with a sliver above the ~50px nav-button floor. The expanded
/// "title + subtitle" height lives in the chrome JS, which owns the visibility
/// check and reports its height back via `x-nv-action://height/<n>` — Rust
/// treats that value as opaque.
pub(super) const CHROME_HEIGHT_BASE: f64 = 52.0;

/// Custom URI scheme the chrome bar `fetch`es to signal Rust; handled by
/// [`register_chrome_action_scheme`], which returns an empty 200. URL shapes:
/// - `x-nv-action://action/<back|forward|refresh>` — button click; Rust
///   dispatches the matching history call on the content webview.
/// - `x-nv-action://height/<logical_px>` — chrome reports its desired height;
///   Rust resizes the chrome + content webviews to match.
const CHROME_ACTION_SCHEME: &str = "x-nv-action";

/// Rust → chrome state push: this global is defined by the chrome's init
/// script and invoked from Rust via `webview.eval(...)`.
pub(super) const WINDOW_TEXT_FN: &str = "window.__nativeWebviewPatchWindowText";

/// Rust → chrome nav-state push for back/forward button enabled state.
/// Tracked Rust-side because Tauri's `Webview` exposes no `can_go_back` /
/// `can_go_forward` predicates — see [`super::state::InstanceState`]'s `nav_*`
/// fields for the approximation.
pub(super) const CHROME_NAV_STATE_FN: &str = "window.__nativeWebviewSetNavState";

/// Rust → chrome URL push, invoked from `on_page_load` (Started) to keep the
/// URL-fallback in sync with navigation — see docs/Lifecycle and Races Explanation.md
/// § "Chrome URL-fallback".
pub(super) const CHROME_SET_URL_FN: &str = "window.__nativeWebviewSetUrl";

/// Rust → chrome reset push for an in-place re-open (see
/// [`super::lifecycle`]'s rewire and docs/Lifecycle and Races Explanation.md
/// § "Re-open rewire"): clears the chrome's claim state + slots, seeds the new
/// URL, re-applies the caller's initial chrome.
pub(super) const CHROME_RESET_TEXT_FN: &str = "window.__nativeWebviewResetWindowText";

/// Full HTML document the chrome webview loads as its source, kept as a
/// standalone [`chrome.html`](./chrome.html) so it edits as HTML rather than a
/// Rust string literal. Base64-encoded into a `data:` URL at runtime (see
/// [`build_chrome_data_url`]); its [`CHROME_STATE_PLACEHOLDER`] is substituted
/// with the seed state so the bar is correct on first paint with no
/// `about:blank` + init-script race.
const CHROME_HTML_TEMPLATE: &str = include_str!("../chrome.html");

/// The `__INITIAL_STATE__` placeholder in [`CHROME_HTML_TEMPLATE`], replaced at
/// runtime with the JSON the chrome's inline script seeds itself from.
const CHROME_STATE_PLACEHOLDER: &str = "__INITIAL_STATE__";

/// Seed state for the chrome's URL-fallback (see docs/Lifecycle and Races Explanation.md
/// § "Chrome URL-fallback"), serialised to JSON and substituted into
/// [`CHROME_STATE_PLACEHOLDER`]. Site-specific: a `None` slot serialises to JSON
/// `null` = "caller hasn't claimed this slot".
#[derive(serde::Serialize)]
pub(super) struct InitialChromeState<'a> {
    pub(super) url: &'a str,
    pub(super) title: Option<&'a str>,
    pub(super) subtitle: Option<&'a str>,
    pub(super) message: Option<&'a str>,
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
pub(super) fn build_chrome_data_url(state: &InitialChromeState) -> crate::Result<Url> {
    const SCRIPT_BREAKOUT_ESCAPE: &str = "\\u003c";
    let json = serde_json::to_string(state)
        .map_err(|error| crate::Error::Internal(error.to_string()))?
        .replace('<', SCRIPT_BREAKOUT_ESCAPE);
    let html = CHROME_HTML_TEMPLATE.replace(CHROME_STATE_PLACEHOLDER, &json);
    let encoded = BASE64.encode(html.as_bytes());
    Url::parse(&format!("data:text/html;base64,{encoded}"))
        .map_err(|error| crate::Error::Internal(error.to_string()))
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
            // (sticky; see [`super::state::InstanceState`]).
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
/// current height from [`super::state::InstanceState::chrome_height`]).
pub(super) fn apply_chrome_height<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    window: &Window<R>,
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
        // Best-effort: skip on a poisoned lock rather than panic (see [`super::state::lock_state`]).
        if let Ok(mut height) = instance.chrome_height.lock() {
            *height = chrome_height;
        }
    }

    // Skip the relayout when the last *applied* layout matches — see
    // [`super::state::InstanceState::applied_layout`].
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
    // mis-sized until some *different* resize. See
    // [`super::state::InstanceState::applied_layout`].
    if chrome.is_some() && content.is_some() {
        if let Some(instance) = &instance {
            if let Ok(mut guard) = instance.applied_layout.lock() {
                *guard = Some(next);
            }
        }
    }
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
