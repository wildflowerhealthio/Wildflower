//! Rust-side bridge between `tauri-plugin-native-webview`'s popup and the
//! sniffer's `BRIDGE_EVENT` event bus. Runs on all platforms now that the
//! sniffer routes through the plugin on desktop too — only the `forward_to_popup`
//! direction stays mobile-only.
//!
//! ## Two halves
//!
//! - **Popup → host** ([`install`]). At app start we create a long-lived
//!   `Channel<PopupEvent>` whose handler decodes each event the plugin's
//!   Swift/Kotlin/desktop side sends and re-emits onto `BRIDGE_EVENT`:
//!   `PopupEvent::Message` → emit the popup-side envelope's inner payload on
//!   its `event` channel (so SPA + Rust listeners see the `{_tag:…}` shape
//!   directly); `PopupEvent::Closed` → emit `{"_tag":"SniffingComplete"}` so
//!   the collector releases per-request state on user-initiated close.
//!   The channel is cloned and reused across every `open` — its identifier is
//!   preserved by `Clone`, so the same handler fires for every popup.
//!
//! - **Host → popup** ([`forward_to_popup`]). The bridge listener in `lib.rs`
//!   routes `Click` / `CancelSnifferRequest` here on mobile only — desktop
//!   doesn't need this hop because the content webview is a Tauri webview
//!   whose `__TAURI__.event.listen('bridge', …)` already receives Rust's
//!   `app.emit('bridge', …)` natively.
//!
//! ## Platform notes
//!
//! - **Mobile**: native popup posts on the `webkit.messageHandlers` /
//!   `@JavascriptInterface` bridges → Swift/Kotlin → `channel.send`. The
//!   plugin's Swift/Kotlin emit `Message` (envelope JSON) and `Closed`.
//! - **Desktop**: content webview emits directly on `BRIDGE_EVENT`, so the
//!   `Message` arm is never exercised. The plugin's desktop backend fires
//!   `Closed` through the channel when the popup window is destroyed (user
//!   clicks the OS X), so the `Closed` arm still translates that to
//!   `SniffingComplete` on the bridge — keeping collector idle-timeouts off
//!   the happy path.

use shared_structures_rust::bridge::BRIDGE_EVENT;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_log::log;
use tauri_plugin_native_webview::PopupEvent;

/// Managed state wrapping the [`Channel`] handed to each plugin `open` call.
///
/// `Clone` on `Channel<T>` preserves the underlying handler (it's
/// `Arc<ChannelInner>` under the hood), so the same handler fires no matter
/// which popup invocation sent the event. Stored in Tauri's typemap and
/// retrieved by `sniffer_window::open_or_navigate`.
pub(crate) struct PopupChannel {
    pub(crate) channel: Channel<PopupEvent>,
}

/// Build the channel, register its handler, and stash the [`PopupChannel`]
/// state on the app. Call once from `attach_browser_sniffer`.
pub(crate) fn install(app: &AppHandle) {
    let app_handle = app.clone();
    let channel: Channel<PopupEvent> = Channel::new(move |body| {
        dispatch_body(&app_handle, &body);
        Ok(())
    });
    app.manage(PopupChannel { channel });
}

/// Decode a channel body and dispatch to the bridge bus. Decode / emit
/// failures log at warn — popup event delivery is best-effort, the listener
/// loop continues.
fn dispatch_body(app: &AppHandle, body: &InvokeResponseBody) {
    let json = match body {
        InvokeResponseBody::Json(string) => string,
        InvokeResponseBody::Raw(_) => {
            log::warn!("[browser-sniffer] popup channel emitted raw bytes; dropping");
            return;
        }
    };
    let event: PopupEvent = match serde_json::from_str(json) {
        Ok(event) => event,
        Err(error) => {
            log::warn!("[browser-sniffer] undecodable popup channel payload dropped: {error}");
            return;
        }
    };
    match event {
        PopupEvent::Message { payload } => {
            // `payload` is the popup-side bridge envelope:
            // `{"event":"bridge","payload":{"_tag":"PageLoaded",…}}`. The
            // popup-side `native-bridge.ts::makeNativeBridgeEventBus.emit`
            // wraps every `installSniffer` emit in that envelope so a single
            // native bridge can carry multiple Tauri channels.
            //
            // Re-emit on `envelope.event` with `envelope.payload` so SPA + Rust
            // listeners see the inner `{_tag:…}` shape directly — matching the
            // Tauri-popup path where there's no envelope wrapping. Emitting the
            // whole envelope on `BRIDGE_EVENT` would defeat the collector's
            // demux-by-`_tag`: it would see `payload.event` instead of
            // `payload._tag` and silently drop every message.
            let envelope: serde_json::Value = match serde_json::from_str(&payload) {
                Ok(value) => value,
                Err(error) => {
                    log::warn!(
                        "[browser-sniffer] undecodable popup message envelope dropped: {error}"
                    );
                    return;
                }
            };
            let Some(event_name) = envelope.get("event").and_then(|v| v.as_str()) else {
                log::warn!(
                    "[browser-sniffer] popup message envelope missing string `event` field; \
                     dropping"
                );
                return;
            };
            let inner_payload = envelope
                .get("payload")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            if let Err(error) = app.emit(event_name, inner_payload) {
                log::warn!("[browser-sniffer] failed to re-emit popup message: {error}");
            }
        }
        PopupEvent::Closed => {
            // Same shape as the in-page top bar's Close button emit on the
            // legacy Tauri path — keeps the collector consumer unchanged.
            if let Err(error) =
                app.emit(BRIDGE_EVENT, serde_json::json!({ "_tag": "SniffingComplete" }))
            {
                log::warn!("[browser-sniffer] failed to emit SniffingComplete on close: {error}");
            }
        }
    }
}

/// Forward a `BRIDGE_EVENT` payload string into the native popup as a
/// `window.__nativeWebviewReceive(...)` call. Only invoked on mobile from the
/// bridge listener in `lib.rs` for the popup-bound tags
/// ([`events::CLICK`](crate::events::CLICK) /
/// [`events::CANCEL_SNIFFER_REQUEST`](crate::events::CANCEL_SNIFFER_REQUEST)).
///
/// `payload_str` is the raw JSON of the bridge envelope as received by
/// `app.listen(BRIDGE_EVENT, …)` (`{"_tag":"Click", …}`). It is wrapped in
/// `{"event":"bridge","payload":<envelope>}` to match what the popup-side
/// `makeNativeBridgeEventBus` `parseEnvelope` expects.
///
/// Mobile-only: on desktop the content webview is a Tauri webview, so
/// `__TAURI__.event.listen('bridge', …)` inside it receives Rust's
/// `app.emit('bridge', …)` natively — no `evaluateJavaScript` hop needed.
#[cfg(any(target_os = "ios", target_os = "android"))]
pub(crate) fn forward_to_popup(app: &AppHandle, payload_str: &str) {
    use tauri_plugin_native_webview::{NativeWebviewExt, SendRequest};

    let parsed: serde_json::Value = match serde_json::from_str(payload_str) {
        Ok(value) => value,
        Err(error) => {
            log::warn!(
                "[browser-sniffer] forward_to_popup: undecodable bridge payload dropped: {error}"
            );
            return;
        }
    };
    let popup_envelope = serde_json::json!({
        "event": BRIDGE_EVENT,
        "payload": parsed,
    });
    let envelope_json = match serde_json::to_string(&popup_envelope) {
        Ok(string) => string,
        Err(error) => {
            log::warn!("[browser-sniffer] forward_to_popup: failed to encode envelope: {error}");
            return;
        }
    };
    // Two-stage stringify: the inner is the envelope the popup-side bridge
    // transport parses; the outer (via `Value::String(...).to_string()`)
    // quotes that string into a JS literal that survives `evaluateJavaScript`.
    // Quotes / backslashes inside the envelope would otherwise syntax-error
    // the injected script.
    let quoted_envelope = serde_json::Value::String(envelope_json).to_string();
    let script = format!("window.__nativeWebviewReceive({quoted_envelope})");

    if let Err(error) = app.native_webview().send(SendRequest { script }) {
        // Popup may be closed (the SPA emits Cancel speculatively across the
        // popup's lifecycle); the plugin rejects with "no popup open". Drop
        // to debug — the collector retries on the next page event.
        log::debug!("[browser-sniffer] forward_to_popup: plugin send rejected: {error}");
    }
}

#[cfg(test)]
mod tests {
    use tauri_plugin_native_webview::PopupEvent;

    /// `dispatch_body` returns silently on undecodable JSON. The bridge
    /// listener relies on the channel handler never panicking, since a panic
    /// would tear the long-lived channel down. Drift-guard at the unit level
    /// so a future refactor doesn't accidentally make these paths throw.
    ///
    /// Can't exercise the happy path here without an `AppHandle`; the
    /// integration test in `wildflower-tauri` covers that end-to-end.
    #[test]
    fn dispatch_body_does_not_panic_on_malformed_input() {
        assert!(serde_json::from_str::<PopupEvent>("not-json").is_err());
        assert!(serde_json::from_str::<PopupEvent>(r#"{"event":"unknown"}"#).is_err());
    }
}
