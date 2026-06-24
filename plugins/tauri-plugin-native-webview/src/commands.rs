//! The IPC commands. Thin wrappers: each builds a typed request and hands
//! off to the platform backend (`mobile::NativeWebview` on iOS/Android, the
//! `desktop::NativeWebview` `WebviewWindow` backend elsewhere) via the
//! [`NativeWebviewExt`] accessor.

use tauri::{ipc::Channel, AppHandle, Runtime};

use crate::models::{OpenRequest, PopupEvent, SendRequest, SetChromeRequest};
use crate::{NativeWebviewExt, Result};

/// Present the external `url` in a native webview popup, injecting `initScript`
/// at document start on any origin (if provided).
///
/// Invoked from the webview as
/// `invoke('plugin:native-webview|open', { url, initScript, channel })` where
/// `channel` is a `new Channel<PopupEvent>()` the caller constructed to
/// receive [`PopupEvent`] payloads from the popup webview. Tauri maps the
/// camelCase `initScript` arg to the snake_case `init_script` parameter.
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
    channel: Channel<PopupEvent>,
) -> Result<()> {
    app.native_webview().open(OpenRequest {
        url,
        init_script,
        channel,
        // JS callers drive chrome through the `setChrome` command; the
        // initial-chrome fields are the Rust-caller convenience path.
        initial_title: None,
        initial_subtitle: None,
        initial_message: None,
    })
}

/// Evaluate `script` inside the currently-open native popup webview.
///
/// Invoked from the webview as
/// `invoke('plugin:native-webview|send', { script })`. The caller owns the
/// content (e.g. the browser-sniffer host emits
/// `window.__nativeWebviewReceive(JSON.stringify({ event, payload }))` to push
/// bridge messages into the popup). Returns an error if no popup is open.
#[tauri::command]
pub(crate) async fn send<R: Runtime>(app: AppHandle<R>, script: String) -> Result<()> {
    app.native_webview().send(SendRequest { script })
}

/// Update one or more of the popup's three chrome labels (`title`,
/// `subtitle`, `message`). Each is `Option<String>`: omitted / `null` =
/// leave unchanged, `""` = clear, otherwise set.
///
/// Invoked from the webview as
/// `invoke('plugin:native-webview|setChrome', { title?, subtitle?, message? })`.
/// The plugin's `open` defaults `title` to the URL host; subsequent changes
/// are caller-driven (the plugin doesn't auto-update on navigation).
#[tauri::command]
pub(crate) async fn set_chrome<R: Runtime>(
    app: AppHandle<R>,
    title: Option<String>,
    subtitle: Option<String>,
    message: Option<String>,
) -> Result<()> {
    app.native_webview().set_chrome(SetChromeRequest {
        title,
        subtitle,
        message,
    })
}

/// Dismiss the currently-presented popup. Idempotent — succeeds with
/// `closed: false` when no popup is open. The dismiss animation runs
/// asynchronously; the native side then emits its usual `PopupEvent::Closed`
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
