//! Rust-side bridge between `tauri-plugin-native-webview`'s popup and the
//! sniffer's `BRIDGE_EVENT` event bus. Runs on all platforms now that the
//! sniffer routes through the plugin on desktop too — only the `forward_to_popup`
//! direction stays mobile-only.
//!
//! ## Two halves
//!
//! - **Popup → host** ([`install`]). At app start we create a long-lived
//!   `Channel<NativeWebviewEvent>` whose handler decodes each event the plugin's
//!   Swift/Kotlin/desktop side sends and re-emits onto `BRIDGE_EVENT`:
//!   `NativeWebviewEvent::Message` → [`validate_popup_message`] checks the (untrusted)
//!   envelope — it must target `BRIDGE_EVENT` AND carry an allowlisted
//!   data-plane `_tag` — then emits its inner payload on the `BRIDGE_EVENT`
//!   channel (so SPA + Rust listeners see the `{_tag:…}` shape directly);
//!   `NativeWebviewEvent::Closed` → emit `{"_tag":"SniffingComplete"}` so the collector
//!   releases per-request state. The plugin suppresses `Closed` for
//!   host-initiated closes (see `sniffing_complete::handle`), so a delivered
//!   `Closed` is always a user / OS dismissal. The channel is cloned and reused
//!   across every `open` — its identifier is preserved by `Clone`, so the same
//!   handler fires for every popup.
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

use std::borrow::Cow;

use serde::Deserialize;
use serde_json::value::RawValue;
use shared_structures_rust::bridge::BRIDGE_EVENT;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_log::log;
use tauri_plugin_native_webview::NativeWebviewEvent;

use crate::events;

/// The web→host data-plane tags the sniffer popup page may raise on the bridge.
/// See [`crate::events`] for the security rationale — control tags are excluded
/// so an untrusted popup can't spoof them. [`tests::data_plane_tags_match_ts`]
/// drift-guards the literals.
const POPUP_DATA_PLANE_TAGS: &[&str] = &[
    events::PAGE_LOADED,
    events::RESPONSE_START,
    events::RESPONSE_DATA,
    events::RESPONSE_FINISHED,
    events::REQUEST_ERROR,
    events::CANCELLED,
    events::LOG,
];

/// Managed state wrapping the [`Channel`] handed to each plugin `open` call.
///
/// `Clone` on `Channel<T>` preserves the underlying handler (it's
/// `Arc<ChannelInner>` under the hood), so the same handler fires no matter
/// which popup invocation sent the event. Stored in Tauri's typemap and
/// retrieved by `sniffer_window::open_or_navigate`.
pub(crate) struct PopupChannel {
    pub(crate) channel: Channel<NativeWebviewEvent>,
}

/// Build the channel, register its handler, and stash the [`PopupChannel`]
/// state on the app. Call once from `attach_browser_sniffer`.
pub(crate) fn install(app: &AppHandle) {
    let app_handle = app.clone();
    let channel: Channel<NativeWebviewEvent> = Channel::new(move |body| {
        dispatch_body(&app_handle, &body);
        Ok(())
    });
    app.manage(PopupChannel { channel });
}

/// The popup-side bridge envelope a `NativeWebviewEvent::Message` carries:
/// `{"event":"bridge","payload":{"_tag":…}}`. `payload` is kept as a borrowed
/// [`RawValue`] so a validated inner payload forwards verbatim — one parse, no
/// intermediate `Value`, no deep clone (this runs once per streamed
/// `ResponseData` chunk on mobile). A missing / `null` `payload` decodes to
/// `None` and is dropped as malformed.
#[derive(Deserialize)]
struct PopupEnvelope<'a> {
    #[serde(borrow)]
    event: &'a str,
    #[serde(borrow, default)]
    payload: Option<&'a RawValue>,
}

/// Just enough of the inner payload to read its discriminant for the allowlist
/// check. A missing / non-string / escaped `_tag` fails to decode and the
/// message is dropped (fail-closed: escape tricks can't slip past the
/// allowlist, they only get rejected).
#[derive(Deserialize)]
struct TagPeek<'a> {
    #[serde(rename = "_tag", borrow)]
    tag: &'a str,
}

/// Validate an untrusted popup `Message` envelope and return the inner payload
/// to re-emit verbatim on `BRIDGE_EVENT`, or an `Err` describing why it was
/// dropped (logged at warn by the caller).
///
/// Security (this is the load-bearing guard): the popup hosts an arbitrary
/// third-party page that can reach the native bridge directly, so both the
/// envelope `event` and the inner `_tag` are attacker-controlled. We require
/// the envelope target the single multiplexed `BRIDGE_EVENT` channel AND the
/// inner `_tag` be one of the sniffer's legitimate web→host data-plane tags
/// ([`POPUP_DATA_PLANE_TAGS`]) — re-emitting anything else would let a hostile
/// page fabricate a `ResponseData`/`ResponseStart`, prematurely raise
/// `SniffingComplete`, or spoof a sibling slice's control tag on the host bus.
fn validate_popup_message(envelope_json: &str) -> Result<&RawValue, Cow<'static, str>> {
    let envelope: PopupEnvelope = serde_json::from_str(envelope_json)
        .map_err(|error| Cow::Owned(format!("undecodable popup message envelope: {error}")))?;
    if envelope.event != BRIDGE_EVENT {
        return Err(Cow::Owned(format!(
            "popup message envelope targeted unexpected event `{}`",
            envelope.event
        )));
    }
    let Some(payload) = envelope.payload else {
        return Err(Cow::Borrowed(
            "popup message envelope had a missing or null payload",
        ));
    };
    let TagPeek { tag } = serde_json::from_str(payload.get())
        .map_err(|_| Cow::Borrowed("popup message payload missing a string `_tag`"))?;
    if !POPUP_DATA_PLANE_TAGS.contains(&tag) {
        return Err(Cow::Owned(format!(
            "popup message tag `{tag}` is not an allowed sniffer data-plane tag; dropping"
        )));
    }
    Ok(payload)
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
    let event: NativeWebviewEvent = match serde_json::from_str(json) {
        Ok(event) => event,
        Err(error) => {
            log::warn!("[browser-sniffer] undecodable popup channel payload dropped: {error}");
            return;
        }
    };
    match event {
        NativeWebviewEvent::Message { payload } => {
            // `payload` is the popup-side bridge envelope:
            // `{"event":"bridge","payload":{"_tag":"PageLoaded",…}}`. The
            // popup-side `native-bridge.ts::makeNativeBridgeEventBus.emit`
            // wraps every `installSniffer` emit in that envelope so a single
            // native bridge can carry multiple Tauri channels.
            //
            // `validate_popup_message` checks the (untrusted) envelope and
            // returns the inner `{_tag:…}` payload to re-emit verbatim on
            // `BRIDGE_EVENT` — so SPA + Rust listeners see the inner shape
            // directly, matching the Tauri-popup path where there's no envelope
            // wrapping. (Emitting the whole envelope would defeat the
            // collector's demux-by-`_tag`.)
            match validate_popup_message(&payload) {
                Ok(inner_payload) => {
                    if let Err(error) = app.emit(BRIDGE_EVENT, inner_payload) {
                        log::warn!("[browser-sniffer] failed to re-emit popup message: {error}");
                    }
                }
                Err(reason) => {
                    log::warn!("[browser-sniffer] popup message dropped: {reason}");
                }
            }
        }
        NativeWebviewEvent::Closed => {
            // The plugin suppresses this echo for host-initiated closes
            // (`sniffing_complete::handle` calls `close(suppress_close_event =
            // true)`), so a `Closed` that reaches here is always a user / OS
            // dismissal — emit `SniffingComplete` so the collector releases
            // per-request state. Same shape as the in-page top bar's Close
            // button emit on the legacy Tauri path.
            if let Err(error) = app.emit(
                BRIDGE_EVENT,
                serde_json::json!({ "_tag": events::SNIFFING_COMPLETE }),
            ) {
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
    use tauri_plugin_native_webview::{EvaluateJsRequest, NativeWebviewExt};

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

    if let Err(error) = app
        .native_webview()
        .evaluate_js(EvaluateJsRequest { script })
    {
        // Popup may be closed (the SPA emits Cancel speculatively across the
        // popup's lifecycle); the plugin rejects with "no popup open". Drop
        // to debug — the collector retries on the next page event.
        log::debug!("[browser-sniffer] forward_to_popup: plugin send rejected: {error}");
    }
}

#[cfg(test)]
mod tests {
    use shared_structures_rust::bridge::BRIDGE_EVENT;
    use tauri_plugin_native_webview::NativeWebviewEvent;

    use super::{validate_popup_message, POPUP_DATA_PLANE_TAGS};
    use crate::events;

    /// Drift guard: the Rust allowlist must match the sniffer's web→host
    /// emit set (`browser-sniffer-core`'s `messages.ts` page→host tags plus
    /// the `Log` console-shim tag in `install-sniffer.ts`). Adding a tag the
    /// page emits without listing it here would silently drop that stream;
    /// listing one the page can't emit would widen the spoofing surface.
    #[test]
    fn data_plane_tags_match_ts() {
        assert_eq!(
            POPUP_DATA_PLANE_TAGS,
            [
                "PageLoaded",
                "ResponseStart",
                "ResponseData",
                "ResponseFinished",
                "RequestError",
                "Cancelled",
                "Log",
            ]
        );
    }

    /// Happy path: a `BRIDGE_EVENT` envelope wrapping an allowlisted
    /// data-plane tag returns the inner payload verbatim for re-emit.
    #[test]
    fn allowlisted_tag_forwards_inner_payload() {
        let json = format!(
            r#"{{"event":"{BRIDGE_EVENT}","payload":{{"_tag":"ResponseData","id":"r1","data":"AA=="}}}}"#
        );
        let inner = validate_popup_message(&json).expect("allowlisted tag forwards");
        // The inner payload is returned untouched (not the whole envelope), so
        // the collector's demux-by-`_tag` sees `_tag`, not `event`.
        assert_eq!(
            inner.get(),
            r#"{"_tag":"ResponseData","id":"r1","data":"AA=="}"#
        );
    }

    /// Every allowlisted tag is accepted (guards a typo'd literal in the set).
    #[test]
    fn every_data_plane_tag_is_accepted() {
        for tag in POPUP_DATA_PLANE_TAGS {
            let json = format!(r#"{{"event":"{BRIDGE_EVENT}","payload":{{"_tag":"{tag}"}}}}"#);
            assert!(
                validate_popup_message(&json).is_ok(),
                "data-plane tag `{tag}` should be allowed"
            );
        }
    }

    /// Security: a control tag the page must NOT be able to raise (it would
    /// prematurely end sniffing) is rejected even though the envelope targets
    /// the right channel. This is the spoofing hole the inner-`_tag` allowlist
    /// closes — the old `event_name`-only check let it through.
    #[test]
    fn spoofed_control_tag_is_rejected() {
        for tag in [
            events::SNIFFING_COMPLETE,
            events::OPEN,
            events::REQUEST_SNIFFABLE_WEBVIEW,
        ] {
            let json = format!(r#"{{"event":"{BRIDGE_EVENT}","payload":{{"_tag":"{tag}"}}}}"#);
            assert!(
                validate_popup_message(&json).is_err(),
                "control tag `{tag}` must not be re-emitted from a popup message"
            );
        }
    }

    /// An envelope targeting a different Tauri event name is refused — the
    /// sniffer only ever multiplexes `BRIDGE_EVENT`.
    #[test]
    fn unexpected_event_name_is_rejected() {
        let json = r#"{"event":"some-other-event","payload":{"_tag":"ResponseData"}}"#;
        assert!(validate_popup_message(json).is_err());
    }

    /// A missing or explicit-null `payload` is dropped as malformed rather
    /// than re-emitting `null` onto the bus (the old code forwarded
    /// `Value::Null`).
    #[test]
    fn missing_or_null_payload_is_dropped() {
        let missing = format!(r#"{{"event":"{BRIDGE_EVENT}"}}"#);
        assert!(validate_popup_message(&missing).is_err());
        let null = format!(r#"{{"event":"{BRIDGE_EVENT}","payload":null}}"#);
        assert!(validate_popup_message(&null).is_err());
    }

    /// A payload with no string `_tag` (or none at all) is dropped — there's
    /// no discriminant to allowlist against.
    #[test]
    fn payload_without_string_tag_is_dropped() {
        let no_tag = format!(r#"{{"event":"{BRIDGE_EVENT}","payload":{{"id":"r1"}}}}"#);
        assert!(validate_popup_message(&no_tag).is_err());
        let non_string = format!(r#"{{"event":"{BRIDGE_EVENT}","payload":{{"_tag":42}}}}"#);
        assert!(validate_popup_message(&non_string).is_err());
    }

    /// Undecodable envelope JSON is an `Err`, not a panic. The bridge listener
    /// relies on the channel handler never panicking — a panic would tear the
    /// long-lived channel down.
    #[test]
    fn malformed_envelope_is_dropped_not_panicked() {
        assert!(validate_popup_message("not-json").is_err());
        // `NativeWebviewEvent` itself still rejects junk at the outer decode layer.
        assert!(serde_json::from_str::<NativeWebviewEvent>("not-json").is_err());
        assert!(serde_json::from_str::<NativeWebviewEvent>(r#"{"event":"unknown"}"#).is_err());
    }
}
