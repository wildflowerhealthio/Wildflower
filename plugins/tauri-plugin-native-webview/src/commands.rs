//! The IPC commands. Thin wrappers: each builds a typed request and hands off to
//! the platform backend (`mobile::NativeWebview` on iOS/Android,
//! `desktop::NativeWebview` elsewhere) via the [`NativeWebviewExt`] accessor.

use tauri::{ipc::Channel, AppHandle, Runtime};

use crate::models::{EvaluateJsRequest, NativeWebviewEvent, OpenRequest, PatchWindowTextRequest};
use crate::{NativeWebviewExt, Result};

/// JS entry point for [`crate::NativeWebviewExt::native_webview`]'s `open_url`.
/// Invoked as
/// `invoke('plugin:native-webview|open_url', { url, initScript, nativeWebviewEventChannel })`,
/// where `nativeWebviewEventChannel` is a `new Channel<NativeWebviewEvent>()` the
/// caller constructed to receive [`NativeWebviewEvent`] payloads. Tauri maps the
/// camelCase args to their snake_case parameters.
///
/// The canonical Rust caller (`browser-sniffer-tauri-rust`'s
/// `sniffer_window::open_or_navigate`) goes through the backend directly so it
/// owns the channel handler instead of round-tripping events through JS.
#[tauri::command]
pub(crate) async fn open_url<R: Runtime>(
    app: AppHandle<R>,
    id: String,
    url: String,
    init_script: Option<String>,
    native_webview_event_channel: Channel<NativeWebviewEvent>,
) -> Result<()> {
    app.native_webview().open_url(
        &id,
        OpenRequest {
            url,
            init_script,
            native_webview_event_channel,
            // JS callers drive window text through the `patch_window_text` command;
            // the initial-chrome fields are the Rust-caller convenience path.
            initial_title: None,
            initial_subtitle: None,
            initial_message: None,
            // Cookie seeding is deliberately not exposed to JS callers — a webview
            // page must never hand the plugin credential material; the Rust host
            // (`native_webview_handle`) is the only seeding path.
            cookies: vec![],
        },
    )
}

/// JS entry point for `evaluate_js`. Invoked as
/// `invoke('plugin:native-webview|evaluate_js', { script })`. The caller owns the
/// content (e.g. the browser-sniffer host emits
/// `window.__nativeWebviewReceive(JSON.stringify({ event, payload }))` to push
/// bridge messages into the native webview). See [`EvaluateJsRequest`].
#[tauri::command]
pub(crate) async fn evaluate_js<R: Runtime>(
    app: AppHandle<R>,
    id: String,
    script: String,
) -> Result<()> {
    app.native_webview()
        .evaluate_js(&id, EvaluateJsRequest { script })
}

/// JS entry point for `patch_window_text`. Invoked as
/// `invoke('plugin:native-webview|patch_window_text', { title?, subtitle?, message? })`.
/// See [`PatchWindowTextRequest`] for the per-slot claim/URL-fallback semantics.
#[tauri::command]
pub(crate) async fn patch_window_text<R: Runtime>(
    app: AppHandle<R>,
    id: String,
    title: Option<String>,
    subtitle: Option<String>,
    message: Option<String>,
) -> Result<()> {
    app.native_webview().patch_window_text(
        &id,
        PatchWindowTextRequest {
            title,
            subtitle,
            message,
        },
    )
}

/// JS entry point for `show` — present a freshly-created or previously-hidden
/// instance. Idempotent (`requestCausedShow: false` when nothing needed
/// presenting). Invoked as `invoke('plugin:native-webview|show', { id })`.
#[tauri::command]
pub(crate) async fn show<R: Runtime>(app: AppHandle<R>, id: String) -> Result<()> {
    app.native_webview().show(&id)
}

/// JS entry point for `hide` — remove from view but keep alive. Idempotent
/// (`requestCausedHide: false` when nothing was visible); emits
/// [`NativeWebviewEvent::Hidden`] on a true transition. Invoked as
/// `invoke('plugin:native-webview|hide', { id })`.
#[tauri::command]
pub(crate) async fn hide<R: Runtime>(app: AppHandle<R>, id: String) -> Result<()> {
    app.native_webview().hide(&id)
}

/// JS entry point for `dispose` — tear down (visible or hidden) and free
/// resources. Idempotent (`requestCausedDispose: false` when none existed);
/// emits [`NativeWebviewEvent::Disposed`] on a true transition. Invoked as
/// `invoke('plugin:native-webview|dispose', { id })`.
#[tauri::command]
pub(crate) async fn dispose<R: Runtime>(app: AppHandle<R>, id: String) -> Result<()> {
    app.native_webview().dispose(&id)
}
