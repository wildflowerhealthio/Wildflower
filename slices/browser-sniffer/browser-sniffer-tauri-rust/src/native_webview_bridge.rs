//! Rust-side bridge between `tauri-plugin-native-webview`'s native webview and
//! the sniffer's `BRIDGE_EVENT` event bus. Runs on all platforms now that the
//! sniffer routes through the plugin on desktop too — only the
//! `forward_to_native_webview` direction stays mobile-only.
//!
//! ## Two halves
//!
//! - **Native webview → host** ([`install`]). At app start we create a
//!   long-lived `Channel<NativeWebviewEvent>` whose handler decodes each event
//!   the plugin's Swift/Kotlin/desktop side sends and re-emits onto
//!   `BRIDGE_EVENT`: `NativeWebviewEvent::Message` →
//!   [`validate_native_webview_message`] checks the (untrusted) envelope — it
//!   must target `BRIDGE_EVENT` AND carry an allowlisted data-plane `_tag` —
//!   then emits its inner payload on the `BRIDGE_EVENT` channel (so SPA + Rust
//!   listeners see the `{_tag:…}` shape directly).
//!   `NativeWebviewEvent::Hidden` / `NativeWebviewEvent::Disposed` are
//!   lifecycle-only — the sniff's terminal `SniffingComplete` is SPA-driven, so
//!   neither re-emits it: a hide keeps the native webview running and sniffing
//!   in the background, and a dispose happens *because* the SPA already emitted
//!   `SniffingComplete`. The channel is cloned and reused across every `open` —
//!   its identifier is preserved by `Clone`, so the same handler fires for every
//!   native webview.
//!
//! - **Host → native webview** ([`forward_to_native_webview`]). The bridge
//!   listener in `lib.rs` routes `Click` / `CancelSnifferRequest` here on mobile
//!   only — desktop doesn't need this hop because the content webview is a Tauri
//!   webview whose `__TAURI__.event.listen('bridge', …)` already receives Rust's
//!   `app.emit('bridge', …)` natively.
//!
//! ## Platform notes
//!
//! - **Mobile**: the native webview posts on the `webkit.messageHandlers` /
//!   `@JavascriptInterface` bridges → Swift/Kotlin → `channel.send`. The
//!   plugin's Swift/Kotlin emit `Message` (envelope JSON) plus `Hidden` /
//!   `Disposed` lifecycle events.
//! - **Desktop**: content webview emits directly on `BRIDGE_EVENT`, so the
//!   `Message` arm is never exercised. The plugin's desktop backend fires
//!   `Hidden` when the user dismisses the window (it's hidden, not destroyed,
//!   and keeps running) and `Disposed` when the window is torn down.

use std::borrow::Cow;
use std::fmt;

use serde::de::{self, MapAccess, Visitor};
use serde::Deserialize;
use serde_json::value::RawValue;
use shared_structures_rust::bridge::BRIDGE_EVENT;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_log::log;
use tauri_plugin_native_webview::NativeWebviewEvent;

use crate::events;

/// The web→host data-plane tags the sniffer's native-webview page may raise on
/// the bridge. See [`crate::events`] for the security rationale — control tags
/// are excluded so an untrusted page can't spoof them.
/// [`tests::data_plane_tags_match_ts`] drift-guards the literals.
const NATIVE_WEBVIEW_DATA_PLANE_TAGS: &[&str] = &[
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
/// which native webview sent the event. Stored in Tauri's typemap and
/// retrieved by `sniffer_window::open_or_navigate`.
pub(crate) struct NativeWebviewChannel {
    pub(crate) channel: Channel<NativeWebviewEvent>,
}

/// Build the channel, register its handler, and stash the
/// [`NativeWebviewChannel`] state on the app. Call once from
/// `attach_browser_sniffer`.
pub(crate) fn install(app: &AppHandle) {
    let app_handle = app.clone();
    let channel: Channel<NativeWebviewEvent> = Channel::new(move |body| {
        dispatch_body(&app_handle, &body);
        Ok(())
    });
    app.manage(NativeWebviewChannel { channel });
}

/// The native-webview-side bridge envelope a `NativeWebviewEvent::Message`
/// carries: `{"event":"bridge","payload":{"_tag":…}}`. `payload` is kept as a
/// borrowed [`RawValue`] so a validated inner payload forwards verbatim — one
/// parse, no intermediate `Value`, no deep clone (this runs once per streamed
/// `ResponseData` chunk on mobile). A missing / `null` `payload` decodes to
/// `None` and is dropped as malformed.
#[derive(Deserialize)]
struct NativeWebviewEnvelope<'a> {
    #[serde(borrow)]
    event: &'a str,
    #[serde(borrow, default)]
    payload: Option<&'a RawValue>,
}

/// Just enough of the inner payload to read its `_tag` discriminant for the
/// allowlist check, while rejecting any duplicate top-level key.
///
/// Hand-written (rather than `#[derive(Deserialize)]`) so it fails on a
/// duplicate of *any* key, not just the duplicate `_tag` serde's struct decode
/// already catches: this guard re-emits the payload's raw bytes verbatim, so it
/// must never accept bytes that a last-wins serde read and a first-wins
/// downstream reader would interpret differently. A missing / non-string /
/// escaped `_tag` also fails to decode and the message is dropped (fail-closed).
struct InnerPayload<'a> {
    tag: &'a str,
}

impl<'de> Deserialize<'de> for InnerPayload<'de> {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct PayloadVisitor;

        impl<'de> Visitor<'de> for PayloadVisitor {
            type Value = InnerPayload<'de>;

            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a native-webview payload object with a unique string `_tag`")
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: MapAccess<'de>,
            {
                // A native-webview payload has a handful of keys, so a linear
                // duplicate scan is cheaper than a set. Keys are borrowed
                // (`&str`); an escaped key fails to borrow and drops the
                // message — fail-closed, and legitimate keys never escape.
                let mut seen: Vec<&str> = Vec::new();
                let mut tag: Option<&str> = None;
                while let Some(key) = map.next_key::<&str>()? {
                    if seen.contains(&key) {
                        return Err(de::Error::custom(format!("duplicate key `{key}`")));
                    }
                    seen.push(key);
                    if key == "_tag" {
                        tag = Some(map.next_value::<&str>()?);
                    } else {
                        // Consume the value without parsing its tree, keeping
                        // the zero-copy hot path intact.
                        map.next_value::<&RawValue>()?;
                    }
                }
                tag.map(|tag| InnerPayload { tag })
                    .ok_or_else(|| de::Error::missing_field("_tag"))
            }
        }

        deserializer.deserialize_map(PayloadVisitor)
    }
}

/// Validate an untrusted native-webview `Message` envelope and return the inner
/// payload to re-emit verbatim on `BRIDGE_EVENT`, or an `Err` describing why it
/// was dropped (logged at warn by the caller).
///
/// Security (this is the load-bearing guard): the native webview hosts an
/// arbitrary third-party page that can reach the native bridge directly, so both
/// the envelope `event` and the inner `_tag` are attacker-controlled. We require
/// the envelope target the single multiplexed `BRIDGE_EVENT` channel AND the
/// inner `_tag` be one of the sniffer's legitimate web→host data-plane tags
/// ([`NATIVE_WEBVIEW_DATA_PLANE_TAGS`]) — re-emitting anything else would let a
/// hostile page fabricate a `ResponseData`/`ResponseStart`, prematurely raise
/// `SniffingComplete`, or spoof a sibling slice's control tag on the host bus.
fn validate_native_webview_message(envelope_json: &str) -> Result<&RawValue, Cow<'static, str>> {
    let envelope: NativeWebviewEnvelope = serde_json::from_str(envelope_json).map_err(|error| {
        Cow::Owned(format!(
            "undecodable native-webview message envelope: {error}"
        ))
    })?;
    if envelope.event != BRIDGE_EVENT {
        return Err(Cow::Owned(format!(
            "native-webview message envelope targeted unexpected event `{}`",
            envelope.event
        )));
    }
    let Some(payload) = envelope.payload else {
        return Err(Cow::Borrowed(
            "native-webview message envelope had a missing or null payload",
        ));
    };
    let InnerPayload { tag } = serde_json::from_str(payload.get())
        .map_err(|error| Cow::Owned(format!("native-webview message payload rejected: {error}")))?;
    if !NATIVE_WEBVIEW_DATA_PLANE_TAGS.contains(&tag) {
        return Err(Cow::Owned(format!(
            "native-webview message tag `{tag}` is not an allowed sniffer data-plane tag; dropping"
        )));
    }
    Ok(payload)
}

/// Decode a channel body and dispatch to the bridge bus. Decode / emit
/// failures log at warn — native-webview event delivery is best-effort, the
/// listener loop continues.
fn dispatch_body(app: &AppHandle, body: &InvokeResponseBody) {
    let json = match body {
        InvokeResponseBody::Json(string) => string,
        InvokeResponseBody::Raw(_) => {
            log::warn!("[browser-sniffer] native-webview channel emitted raw bytes; dropping");
            return;
        }
    };
    let event: NativeWebviewEvent = match serde_json::from_str(json) {
        Ok(event) => event,
        Err(error) => {
            log::warn!(
                "[browser-sniffer] undecodable native-webview channel payload dropped: {error}"
            );
            return;
        }
    };
    match event {
        NativeWebviewEvent::Message { payload } => {
            // `payload` is the native-webview-side bridge envelope:
            // `{"event":"bridge","payload":{"_tag":"PageLoaded",…}}`. The
            // native-webview-side `native-bridge.ts::makeNativeBridgeEventBus.emit`
            // wraps every `installSniffer` emit in that envelope so a single
            // native bridge can carry multiple Tauri channels.
            //
            // `validate_native_webview_message` checks the (untrusted) envelope
            // and returns the inner `{_tag:…}` payload to re-emit verbatim on
            // `BRIDGE_EVENT` — so SPA + Rust listeners see the inner shape
            // directly, matching the Tauri-webview path where there's no
            // envelope wrapping. (Emitting the whole envelope would defeat the
            // collector's demux-by-`_tag`.)
            match validate_native_webview_message(&payload) {
                Ok(inner_payload) => {
                    if let Err(error) = app.emit(BRIDGE_EVENT, inner_payload) {
                        log::warn!(
                            "[browser-sniffer] failed to re-emit native-webview message: {error}"
                        );
                    }
                }
                Err(reason) => {
                    log::warn!("[browser-sniffer] native-webview message dropped: {reason}");
                }
            }
        }
        NativeWebviewEvent::Hidden => {
            // A user dismissal hid the native webview, but it stays alive and
            // keeps sniffing in the background. This is NOT terminal — the SPA
            // owns `SniffingComplete` — so emit nothing; collection continues
            // until the SPA decides the sniff is done.
            log::debug!(
                "[browser-sniffer] native webview hidden; sniff continues in the background"
            );
        }
        NativeWebviewEvent::Disposed => {
            // The native webview was torn down — the host disposed it (after the
            // SPA's own `SniffingComplete`) or the teardown backstop fired. The
            // SPA already observed the terminal `SniffingComplete`, so there's
            // nothing to re-emit here.
            log::debug!("[browser-sniffer] native webview disposed");
        }
    }
}

/// Forward a `BRIDGE_EVENT` payload string into the native webview as a
/// `window.__nativeWebviewReceive(...)` call. Only invoked on mobile from the
/// bridge listener in `lib.rs` for the native-webview-bound tags
/// ([`events::CLICK`](crate::events::CLICK) /
/// [`events::CANCEL_SNIFFER_REQUEST`](crate::events::CANCEL_SNIFFER_REQUEST)).
///
/// `payload_str` is the raw JSON of the bridge envelope as received by
/// `app.listen(BRIDGE_EVENT, …)` (`{"_tag":"Click", …}`). It is wrapped in
/// `{"event":"bridge","payload":<envelope>}` to match what the
/// native-webview-side `makeNativeBridgeEventBus` `parseEnvelope` expects.
///
/// Mobile-only: on desktop the content webview is a Tauri webview, so
/// `__TAURI__.event.listen('bridge', …)` inside it receives Rust's
/// `app.emit('bridge', …)` natively — no `evaluateJavaScript` hop needed.
#[cfg(any(target_os = "ios", target_os = "android"))]
pub(crate) fn forward_to_native_webview(app: &AppHandle, payload_str: &str) {
    use serde::Serialize;
    use tauri_plugin_native_webview::{EvaluateJsRequest, NativeWebviewExt};

    /// The envelope the native-webview-side `makeNativeBridgeEventBus::parseEnvelope`
    /// expects: the bridge channel name plus the inbound payload forwarded
    /// verbatim as a borrowed `RawValue` — one parse, no intermediate `Value`,
    /// no deep clone (the outbound mirror of [`NativeWebviewEnvelope`]).
    #[derive(Serialize)]
    struct OutboundEnvelope<'a> {
        event: &'a str,
        payload: &'a RawValue,
    }

    // We only re-wrap the payload, never inspect its tree, so parse it as a
    // borrowed `RawValue`: this validates it's well-formed JSON (a malformed
    // payload must not inject broken script) and lets us forward it verbatim.
    let payload: &RawValue = match serde_json::from_str(payload_str) {
        Ok(value) => value,
        Err(error) => {
            log::warn!(
                "[browser-sniffer] forward_to_native_webview: undecodable bridge payload dropped: \
                 {error}"
            );
            return;
        }
    };
    let envelope_json = match serde_json::to_string(&OutboundEnvelope {
        event: BRIDGE_EVENT,
        payload,
    }) {
        Ok(string) => string,
        Err(error) => {
            log::warn!(
                "[browser-sniffer] forward_to_native_webview: failed to encode envelope: {error}"
            );
            return;
        }
    };
    // Two-stage stringify: the inner is the envelope the native-webview-side
    // bridge transport parses; the outer (via `Value::String(...).to_string()`)
    // quotes that string into a JS literal that survives `evaluateJavaScript`.
    // Quotes / backslashes inside the envelope would otherwise syntax-error
    // the injected script.
    let quoted_envelope = serde_json::Value::String(envelope_json).to_string();
    let script = format!("window.__nativeWebviewReceive({quoted_envelope})");

    if let Err(error) = app
        .native_webview()
        .evaluate_js(EvaluateJsRequest { script })
    {
        // The native webview may already be closed (the SPA emits Cancel
        // speculatively across its lifecycle); the plugin then rejects because
        // none is open. Drop to debug — the collector retries on the next page
        // event.
        log::debug!("[browser-sniffer] forward_to_native_webview: plugin send rejected: {error}");
    }
}

#[cfg(test)]
mod tests {
    use shared_structures_rust::bridge::BRIDGE_EVENT;
    use tauri_plugin_native_webview::NativeWebviewEvent;

    use super::{validate_native_webview_message, NATIVE_WEBVIEW_DATA_PLANE_TAGS};
    use crate::events;

    /// Drift guard: the Rust allowlist must match the sniffer's web→host
    /// emit set (`browser-sniffer-core`'s `messages.ts` page→host tags plus
    /// the `Log` console-shim tag in `install-sniffer.ts`). Adding a tag the
    /// page emits without listing it here would silently drop that stream;
    /// listing one the page can't emit would widen the spoofing surface.
    #[test]
    fn data_plane_tags_match_ts() {
        assert_eq!(
            NATIVE_WEBVIEW_DATA_PLANE_TAGS,
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
        let inner = validate_native_webview_message(&json).expect("allowlisted tag forwards");
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
        for tag in NATIVE_WEBVIEW_DATA_PLANE_TAGS {
            let json = format!(r#"{{"event":"{BRIDGE_EVENT}","payload":{{"_tag":"{tag}"}}}}"#);
            assert!(
                validate_native_webview_message(&json).is_ok(),
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
                validate_native_webview_message(&json).is_err(),
                "control tag `{tag}` must not be re-emitted from a native-webview message"
            );
        }
    }

    /// An envelope targeting a different Tauri event name is refused — the
    /// sniffer only ever multiplexes `BRIDGE_EVENT`.
    #[test]
    fn unexpected_event_name_is_rejected() {
        let json = r#"{"event":"some-other-event","payload":{"_tag":"ResponseData"}}"#;
        assert!(validate_native_webview_message(json).is_err());
    }

    /// A missing or explicit-null `payload` is dropped as malformed rather
    /// than re-emitting `null` onto the bus (the old code forwarded
    /// `Value::Null`).
    #[test]
    fn missing_or_null_payload_is_dropped() {
        let missing = format!(r#"{{"event":"{BRIDGE_EVENT}"}}"#);
        assert!(validate_native_webview_message(&missing).is_err());
        let null = format!(r#"{{"event":"{BRIDGE_EVENT}","payload":null}}"#);
        assert!(validate_native_webview_message(&null).is_err());
    }

    /// A payload with no string `_tag` (or none at all) is dropped — there's
    /// no discriminant to allowlist against.
    #[test]
    fn payload_without_string_tag_is_dropped() {
        let no_tag = format!(r#"{{"event":"{BRIDGE_EVENT}","payload":{{"id":"r1"}}}}"#);
        assert!(validate_native_webview_message(&no_tag).is_err());
        let non_string = format!(r#"{{"event":"{BRIDGE_EVENT}","payload":{{"_tag":42}}}}"#);
        assert!(validate_native_webview_message(&non_string).is_err());
    }

    /// Security: a payload with a duplicate top-level key is rejected. The
    /// validated `_tag` (serde last-wins) could otherwise disagree with the
    /// verbatim-re-emitted raw bytes a first-wins downstream reader sees — a
    /// duplicate `_tag` whose first occurrence is a rejected control tag must
    /// not slip past the allowlist. We reject any duplicate key, not just
    /// `_tag`, so the re-broadcast bytes are never attacker-shaped.
    #[test]
    fn duplicate_keys_are_rejected() {
        let dup_tag = format!(
            r#"{{"event":"{BRIDGE_EVENT}","payload":{{"_tag":"SniffingComplete","_tag":"Log"}}}}"#
        );
        assert!(validate_native_webview_message(&dup_tag).is_err());
        let dup_other = format!(
            r#"{{"event":"{BRIDGE_EVENT}","payload":{{"_tag":"ResponseData","id":"a","id":"b"}}}}"#
        );
        assert!(validate_native_webview_message(&dup_other).is_err());
    }

    /// Undecodable envelope JSON is an `Err`, not a panic. The bridge listener
    /// relies on the channel handler never panicking — a panic would tear the
    /// long-lived channel down.
    #[test]
    fn malformed_envelope_is_dropped_not_panicked() {
        assert!(validate_native_webview_message("not-json").is_err());
        // `NativeWebviewEvent` itself still rejects junk at the outer decode layer.
        assert!(serde_json::from_str::<NativeWebviewEvent>("not-json").is_err());
        assert!(serde_json::from_str::<NativeWebviewEvent>(r#"{"event":"unknown"}"#).is_err());
    }
}
