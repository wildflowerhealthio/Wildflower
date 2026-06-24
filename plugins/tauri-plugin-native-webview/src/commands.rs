//! The IPC commands. Thin wrappers: each builds a typed request and hands
//! off to the platform backend (`mobile::NativeWebview` on iOS/Android, the
//! `desktop::NativeWebview` `WebviewWindow` backend elsewhere) via the
//! [`NativeWebviewExt`] accessor.

use tauri::{ipc::Channel, AppHandle, Runtime};

use crate::models::{EvaluateJsRequest, NativeWebviewEvent, OpenRequest, PatchWindowTextRequest};
use crate::{NativeWebviewExt, Result};

/// Ensure a native webview exists (creating it hidden if absent) and navigate it
/// to `url`, injecting `initScript` at document start on any origin (if
/// provided). Does **not** change visibility — content and presentation are
/// separate concerns; call `show` to present.
///
/// Invoked from the webview as
/// `invoke('plugin:native-webview|open_url', { url, initScript, nativeWebviewEventChannel })`
/// where `nativeWebviewEventChannel` is a `new Channel<NativeWebviewEvent>()` the caller
/// constructed to receive [`NativeWebviewEvent`] payloads from the native
/// webview. Tauri maps the camelCase args to their snake_case parameters.
///
/// Rust callers go through [`crate::NativeWebviewExt::native_webview`] +
/// `open_url(OpenRequest { … })` directly — see `browser-sniffer-tauri-rust`'s
/// `sniffer_window::open_or_navigate` for the canonical Rust-side caller, which
/// owns the channel handler instead of round-tripping events through JS.
#[tauri::command]
pub(crate) async fn open_url<R: Runtime>(
    app: AppHandle<R>,
    url: String,
    init_script: Option<String>,
    native_webview_event_channel: Channel<NativeWebviewEvent>,
) -> Result<()> {
    app.native_webview().open_url(OpenRequest {
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

/// Present the native webview — bring a freshly-created or previously-hidden
/// instance to the foreground. Idempotent — succeeds with `shown: false` when
/// none exists. Visibility only; `open_url` owns navigation. The native side
/// presents the live instance (no re-navigation, no teardown).
///
/// Invoked from the webview as `invoke('plugin:native-webview|show')`. Rust
/// callers go through [`crate::NativeWebviewExt::native_webview`] + `show()`.
#[tauri::command]
pub(crate) async fn show<R: Runtime>(app: AppHandle<R>) -> Result<()> {
    app.native_webview().show()
}

/// Hide the currently-presented native webview — remove it from view but keep
/// it alive and running. Idempotent — succeeds with `hidden: false` when none is
/// visible. The native side emits [`NativeWebviewEvent::Hidden`] once hidden; a
/// later `open` re-presents the same live instance.
///
/// Invoked from the webview as `invoke('plugin:native-webview|hide')`. Rust
/// callers go through [`crate::NativeWebviewExt::native_webview`] + `hide()`.
#[tauri::command]
pub(crate) async fn hide<R: Runtime>(app: AppHandle<R>) -> Result<()> {
    app.native_webview().hide()
}

/// Dispose the native webview — tear it down (visible or hidden) and free its
/// resources. Idempotent — succeeds with `disposed: false` when none exists. The
/// native side emits [`NativeWebviewEvent::Disposed`] once torn down; a later
/// `open` builds a fresh instance.
///
/// Invoked from the webview as `invoke('plugin:native-webview|dispose')`. Rust
/// callers go through [`crate::NativeWebviewExt::native_webview`] + `dispose()`.
#[tauri::command]
pub(crate) async fn dispose<R: Runtime>(app: AppHandle<R>) -> Result<()> {
    app.native_webview().dispose()
}
