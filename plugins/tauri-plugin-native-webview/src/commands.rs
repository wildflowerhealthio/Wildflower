//! The IPC commands. Thin wrappers: each builds a typed request and hands
//! off to the platform backend (`mobile::NativeWebview` on iOS/Android, the
//! `desktop::NativeWebview` `WebviewWindow` backend elsewhere) via the
//! [`NativeWebviewExt`] accessor.

use tauri::{ipc::Channel, AppHandle, Runtime};

use crate::models::{EvaluateJsRequest, NativeWebviewEvent, OpenRequest, PatchWindowTextRequest};
use crate::{NativeWebviewExt, Result};

/// Present the external `url` in a native webview, injecting `initScript`
/// at document start on any origin (if provided).
///
/// Invoked from the webview as
/// `invoke('plugin:native-webview|open', { url, initScript, nativeWebviewEventChannel })`
/// where `nativeWebviewEventChannel` is a `new Channel<NativeWebviewEvent>()` the caller
/// constructed to receive [`NativeWebviewEvent`] payloads from the native
/// webview. Tauri maps the camelCase args to their snake_case parameters.
///
/// Rust callers go through [`crate::NativeWebviewExt::native_webview`] +
/// `open(OpenRequest { … })` directly — see `browser-sniffer-tauri-rust`'s
/// `sniffer_window::open_or_navigate` for the canonical Rust-side caller, which
/// owns the channel handler instead of round-tripping events through JS.
#[tauri::command]
pub(crate) async fn open<R: Runtime>(
    app: AppHandle<R>,
    url: String,
    init_script: Option<String>,
    native_webview_event_channel: Channel<NativeWebviewEvent>,
) -> Result<()> {
    app.native_webview().open(OpenRequest {
        url,
        init_script,
        native_webview_event_channel,
        // JS callers drive window text through the `patchWindowText` command;
        // the initial-chrome fields are the Rust-caller convenience path.
        initial_title: None,
        initial_subtitle: None,
        initial_message: None,
    })
}

/// Evaluate `script` inside the currently-open native webview.
///
/// Invoked from the webview as
/// `invoke('plugin:native-webview|evaluate_js', { script })`. The caller owns
/// the content (e.g. the browser-sniffer host emits
/// `window.__nativeWebviewReceive(JSON.stringify({ event, payload }))` to push
/// bridge messages into the native webview). Returns an error if no native webview is open.
#[tauri::command]
pub(crate) async fn evaluate_js<R: Runtime>(app: AppHandle<R>, script: String) -> Result<()> {
    app.native_webview()
        .evaluate_js(EvaluateJsRequest { script })
}

/// Patch one or more of the native webview's three window-text labels (`title`,
/// `subtitle`, `message`). Each is `Option<String>`: omitted / `null` =
/// leave unchanged, `""` = clear, otherwise set.
///
/// Invoked from the webview as
/// `invoke('plugin:native-webview|patch_window_text', { title?, subtitle?, message? })`.
/// Until a slot is claimed by a caller value, it shows the page URL (which
/// tracks navigation); the first value the caller sends for a slot claims it
/// and the URL falls through to the next unclaimed slot.
#[tauri::command]
pub(crate) async fn patch_window_text<R: Runtime>(
    app: AppHandle<R>,
    title: Option<String>,
    subtitle: Option<String>,
    message: Option<String>,
) -> Result<()> {
    app.native_webview()
        .patch_window_text(PatchWindowTextRequest {
            title,
            subtitle,
            message,
        })
}

/// Dismiss the currently-presented native webview. Idempotent — succeeds with
/// `closed_by_request: false` when no native webview is open. The dismiss animation runs
/// asynchronously; the native side then emits its usual `NativeWebviewEvent::Closed`
/// through the open channel once the animation finishes — unless
/// `suppressCloseEvent` is `true`, in which case this one dismissal stays
/// silent (a host that already observed the terminal event needn't see the
/// echo). Omitted / `false` keeps the symmetric "every close emits" posture.
///
/// Invoked from the webview as
/// `invoke('plugin:native-webview|close', { suppressCloseEvent? })`. JS callers
/// that omit the arg get the default `false`. Rust callers go through
/// [`crate::NativeWebviewExt::native_webview`] + `close(suppress_close_event)`.
#[tauri::command]
pub(crate) async fn close<R: Runtime>(
    app: AppHandle<R>,
    suppress_close_event: Option<bool>,
) -> Result<()> {
    app.native_webview()
        .close(suppress_close_event.unwrap_or(false))
}
