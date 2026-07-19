//! Rust-side bridge between `tauri-plugin-native-webview`'s native webview and
//! the sniffer's `BRIDGE_EVENT` event bus. See
//! [`Tauri Host Explanation.md`](../../docs/Tauri%20Host%20Explanation.md) for
//! the full data-plane / transport plumbing.
//!
//! - **Native webview → host** ([`install`]): a long-lived
//!   `Channel<NativeWebviewEvent>` decodes each plugin event and re-emits onto
//!   `BRIDGE_EVENT`. `Message` is validated ([`validate_native_webview_message`])
//!   and its inner payload forwarded; `Hidden` / `Disposed` are lifecycle-only
//!   (the terminal `SniffingComplete` is SPA-driven, so neither re-emits it).
//!   The channel is cloned and reused across opens — `Clone` preserves the
//!   handler, so it fires for every native webview.
//! - **Host → native webview** ([`forward_to_native_webview`]): mobile-only.
//!   Desktop's content webview is a Tauri webview that receives
//!   `app.emit('bridge', …)` natively.
//! - **Desktop data plane**: the content webview can't emit on `BRIDGE_EVENT`
//!   (its capability withholds the `emit` grant), so it rides the
//!   [`native_webview_data_plane_emit`] command — the desktop counterpart of
//!   the mobile `Message` allowlist gate.

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
/// `Clone` on `Channel<T>` preserves the underlying handler (`Arc<ChannelInner>`),
/// so the same handler fires no matter which native webview sent the event.
/// Stored in Tauri's typemap, retrieved by `sniffer_window::open_or_navigate`.
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
/// carries: `{"event":"bridge","payload":{"_tag":…}}`. `payload` is a borrowed
/// [`RawValue`] so a validated inner payload **forwards verbatim** — no
/// intermediate `Value`, no deep clone. The inner payload is scanned a second
/// time by [`validate_native_webview_message`] to read its `_tag` and reject
/// duplicate keys (forwarding is zero-copy; validation is not). A missing /
/// `null` `payload` decodes to `None` and is dropped as malformed.
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
/// Hand-written (not `#[derive(Deserialize)]`) so it fails on a duplicate of
/// *any* key, not just `_tag`: this guard re-emits the raw bytes verbatim, so it
/// must never accept bytes that last-wins serde and a first-wins downstream
/// reader would interpret differently. A missing / non-string / escaped `_tag`
/// also fails to decode and the message is dropped (fail-closed).
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
                // A payload has a handful of keys, so a linear duplicate scan
                // beats a set. Keys are borrowed (`&str`); an escaped key fails
                // to borrow and drops the message (fail-closed; legitimate keys
                // never escape).
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
/// Security (the mobile path's load-bearing guard; desktop's counterpart is
/// [`data_plane_value_is_allowed`]): the native webview hosts an arbitrary
/// third-party page that can reach the native bridge directly, so both the
/// envelope `event` and the inner `_tag` are attacker-controlled. We require the
/// envelope target `BRIDGE_EVENT` AND the inner `_tag` be an allowlisted
/// data-plane tag ([`NATIVE_WEBVIEW_DATA_PLANE_TAGS`]) — re-emitting anything
/// else would let a hostile page fabricate a data event, prematurely raise
/// `SniffingComplete`, or spoof a sibling slice's control tag.
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
    // Read the inner `_tag` for the allowlist and reject duplicate keys (see
    // [`InnerPayload`]).
    let InnerPayload { tag } = serde_json::from_str(payload.get())
        .map_err(|error| Cow::Owned(format!("native-webview message payload rejected: {error}")))?;
    if !NATIVE_WEBVIEW_DATA_PLANE_TAGS.contains(&tag) {
        return Err(Cow::Owned(format!(
            "native-webview message tag `{tag}` is not an allowed sniffer data-plane tag; dropping"
        )));
    }
    Ok(payload)
}

/// The action [`dispatch_body`] takes for a decoded [`NativeWebviewEvent`],
/// factored out so the dispatch decision is unit-testable without an
/// `AppHandle`. A `ReEmit` borrows its payload from the event it was decoded
/// from, so the lifetime ties the two together.
#[derive(Debug)]
enum BridgeAction<'a> {
    /// Re-emit this inner payload verbatim on `BRIDGE_EVENT`.
    ReEmit(&'a RawValue),
    /// Drop a `Message` that failed envelope / allowlist validation; the `Cow`
    /// is the warn-logged reason.
    Drop(Cow<'static, str>),
    /// A lifecycle event (`Hidden` / `Disposed`) — log the carried note at debug
    /// and re-emit nothing (the SPA owns the terminal `SniffingComplete`).
    Lifecycle(&'static str),
}

/// Decide what to do with a decoded native-webview event. Pure (no `AppHandle`,
/// no I/O) so the security-critical `Message` validation and the lifecycle
/// no-emit arms are unit-testable; [`dispatch_body`] performs the effects.
fn classify_event(event: &NativeWebviewEvent) -> BridgeAction<'_> {
    match event {
        NativeWebviewEvent::Message { payload } => match validate_native_webview_message(payload) {
            Ok(inner_payload) => BridgeAction::ReEmit(inner_payload),
            Err(reason) => BridgeAction::Drop(reason),
        },
        // Neither is terminal: hide keeps the webview sniffing, dispose follows
        // the SPA's own `SniffingComplete`. See [`BridgeAction::Lifecycle`].
        NativeWebviewEvent::Hidden => {
            BridgeAction::Lifecycle("native webview hidden; sniff continues in the background")
        }
        NativeWebviewEvent::Disposed => BridgeAction::Lifecycle("native webview disposed"),
    }
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
    match classify_event(&event) {
        BridgeAction::ReEmit(inner_payload) => {
            if let Err(error) = app.emit(BRIDGE_EVENT, inner_payload) {
                log::warn!("[browser-sniffer] failed to re-emit native-webview message: {error}");
            }
        }
        BridgeAction::Drop(reason) => {
            log::warn!("[browser-sniffer] native-webview message dropped: {reason}");
        }
        BridgeAction::Lifecycle(note) => {
            log::debug!("[browser-sniffer] {note}");
        }
    }
}

/// Forward a `BRIDGE_EVENT` payload string into the native webview as a
/// `window.__nativeWebviewReceive(...)` call. Mobile-only, invoked from the
/// bridge listener in `lib.rs` for the native-webview-bound tags
/// ([`events::PAGE_ACTION`](crate::events::PAGE_ACTION) /
/// [`events::CANCEL_SNIFFER_REQUEST`](crate::events::CANCEL_SNIFFER_REQUEST));
/// desktop's content webview receives `app.emit('bridge', …)` natively.
///
/// `payload_str` is the raw bridge envelope (`{"_tag":"PageAction", …}`), re-wrapped
/// in `{"event":"bridge","payload":<envelope>}` to match the native-webview-side
/// `makeNativeBridgeEventBus` `parseEnvelope`.
#[cfg(any(target_os = "ios", target_os = "android"))]
pub(crate) fn forward_to_native_webview(app: &AppHandle, payload_str: &str) {
    use serde::Serialize;
    use tauri_plugin_native_webview::{EvaluateJsRequest, NativeWebviewExt};

    /// Outbound mirror of [`NativeWebviewEnvelope`]: payload forwarded verbatim
    /// as a borrowed `RawValue` (no intermediate `Value`, no deep clone).
    #[derive(Serialize)]
    struct OutboundEnvelope<'a> {
        event: &'a str,
        payload: &'a RawValue,
    }

    // Parse as a borrowed `RawValue`: validates it's well-formed JSON (a
    // malformed payload must not inject broken script) and forwards verbatim.
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
    // Two-stage stringify: `envelope_json` is what the native-webview bridge
    // parses; quoting it as a JS string literal escapes quotes/backslashes that
    // would otherwise syntax-error the injected `evaluateJavaScript` script.
    let quoted_envelope = serde_json::Value::String(envelope_json).to_string();
    let script = format!("window.__nativeWebviewReceive({quoted_envelope})");

    if let Err(error) = app
        .native_webview()
        .evaluate_js(crate::SNIFFER_WEBVIEW_ID, EvaluateJsRequest { script })
    {
        // Two failure modes hide behind one reject. The SPA emits Cancel
        // speculatively, so a closed webview is benign/expected (debug);
        // anything else dropped a real user action and stays at warn. We match
        // the message string because the plugin's mobile `Error` carries only a
        // string (`PluginInvoke`), not a kind.
        const NO_WEBVIEW_OPEN: &str = "no native webview open";
        let message = error.to_string();
        if message.contains(NO_WEBVIEW_OPEN) {
            log::debug!(
                "[browser-sniffer] forward_to_native_webview: no native webview open (expected for \
                 a speculative Cancel): {error}"
            );
        } else {
            log::warn!("[browser-sniffer] forward_to_native_webview: plugin send failed: {error}");
        }
    }
}

/// Validate a desktop content-webview data-plane payload before re-broadcasting
/// it on `BRIDGE_EVENT`. The inner `_tag` must be allowlisted
/// ([`NATIVE_WEBVIEW_DATA_PLANE_TAGS`]) — the same gate mobile's
/// [`validate_native_webview_message`] applies.
///
/// This validates a parsed [`serde_json::Value`] and re-emits that *same*
/// `Value`, so the [`InnerPayload`] duplicate-key concern doesn't apply: the
/// bytes a downstream reader sees and the `_tag` we checked are necessarily one.
fn data_plane_value_is_allowed(payload: &serde_json::Value) -> Result<(), Cow<'static, str>> {
    let Some(tag) = payload.get("_tag").and_then(serde_json::Value::as_str) else {
        return Err(Cow::Borrowed(
            "desktop native-webview data-plane payload had a missing or non-string `_tag`",
        ));
    };
    if !NATIVE_WEBVIEW_DATA_PLANE_TAGS.contains(&tag) {
        return Err(Cow::Owned(format!(
            "desktop native-webview data-plane tag `{tag}` is not an allowed sniffer data-plane \
             tag; dropping"
        )));
    }
    Ok(())
}

/// Desktop-only transport for the content webview's web→host data-plane stream.
///
/// The content webview is a Tauri webview loading arbitrary third-party content,
/// so it is **not** trusted to emit on `BRIDGE_EVENT` directly:
/// `capabilities/native-webview-window.json` withholds the `emit` grant and
/// allows only this command, which allowlists the inner `_tag`
/// ([`data_plane_value_is_allowed`]) before re-broadcasting — the desktop
/// counterpart of the mobile [`validate_native_webview_message`] gate.
///
/// Best-effort: a rejected or unemittable payload is logged at warn and dropped.
/// Registered unconditionally in the app's `invoke_handler`, but desktop-only in
/// practice — mobile's native webview can't reach Tauri commands.
#[tauri::command]
pub fn native_webview_data_plane_emit(app: AppHandle, payload: serde_json::Value) {
    match data_plane_value_is_allowed(&payload) {
        Ok(()) => {
            if let Err(error) = app.emit(BRIDGE_EVENT, &payload) {
                log::warn!(
                    "[browser-sniffer] desktop native-webview data-plane re-emit failed: {error}"
                );
            }
        }
        Err(reason) => {
            log::warn!(
                "[browser-sniffer] desktop native-webview data-plane emit dropped: {reason}"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use shared_structures_rust::bridge::BRIDGE_EVENT;
    use tauri_plugin_native_webview::NativeWebviewEvent;

    use super::{
        classify_event, data_plane_value_is_allowed, validate_native_webview_message, BridgeAction,
        NATIVE_WEBVIEW_DATA_PLANE_TAGS,
    };
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
        // Inner payload returned untouched (not the whole envelope), so the
        // collector's demux-by-`_tag` sees `_tag`, not `event`.
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

    /// Security: a duplicate top-level key is rejected. The validated `_tag`
    /// (serde last-wins) could otherwise disagree with the verbatim-re-emitted
    /// bytes a first-wins downstream reader sees — a duplicate `_tag` whose first
    /// occurrence is a rejected control tag must not slip past the allowlist. We
    /// reject any duplicate key so the re-broadcast bytes are never attacker-shaped.
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

    /// Desktop transport: an allowlisted data-plane tag passes the
    /// [`super::native_webview_data_plane_emit`] gate, and every tag in the set
    /// is accepted (guards a typo'd literal, mirroring the mobile path).
    #[test]
    fn desktop_data_plane_accepts_allowlisted_tags() {
        for tag in NATIVE_WEBVIEW_DATA_PLANE_TAGS {
            let payload = serde_json::json!({ "_tag": tag, "id": "r1" });
            assert!(
                data_plane_value_is_allowed(&payload).is_ok(),
                "desktop data-plane tag `{tag}` should be allowed"
            );
        }
    }

    /// Desktop transport security: the same control tags the mobile
    /// [`spoofed_control_tag_is_rejected`] guard blocks are rejected here too, so
    /// a hostile content webview can't reach the command to forge them onto the
    /// bus — the desktop counterpart of the mobile spoof-rejection guard.
    #[test]
    fn desktop_data_plane_rejects_spoofed_control_tags() {
        for tag in [
            events::SNIFFING_COMPLETE,
            events::OPEN,
            events::REQUEST_SNIFFABLE_WEBVIEW,
        ] {
            let payload = serde_json::json!({ "_tag": tag });
            assert!(
                data_plane_value_is_allowed(&payload).is_err(),
                "control tag `{tag}` must not be re-emittable through the desktop command"
            );
        }
    }

    /// Desktop transport: a payload with no string `_tag` is dropped — there's no
    /// discriminant to allowlist against (fail-closed, as the mobile path is).
    #[test]
    fn desktop_data_plane_rejects_missing_or_non_string_tag() {
        assert!(data_plane_value_is_allowed(&serde_json::json!({ "id": "r1" })).is_err());
        assert!(data_plane_value_is_allowed(&serde_json::json!({ "_tag": 42 })).is_err());
    }

    /// Dispatch classification: a `Message` wrapping an allowlisted data-plane
    /// tag re-emits its inner payload verbatim (the load-bearing forward path).
    #[test]
    fn message_with_allowlisted_tag_classifies_as_reemit() {
        let event = NativeWebviewEvent::Message {
            payload: format!(
                r#"{{"event":"{BRIDGE_EVENT}","payload":{{"_tag":"ResponseData","id":"r1"}}}}"#
            ),
        };
        match classify_event(&event) {
            BridgeAction::ReEmit(inner) => {
                assert_eq!(inner.get(), r#"{"_tag":"ResponseData","id":"r1"}"#);
            }
            other => panic!("expected ReEmit, got {other:?}"),
        }
    }

    /// Dispatch classification: a `Message` carrying a spoofed control tag is
    /// dropped, never re-emitted — the security allowlist reached through the
    /// dispatch path, not just `validate_native_webview_message` in isolation.
    #[test]
    fn message_with_control_tag_classifies_as_drop() {
        let event = NativeWebviewEvent::Message {
            payload: format!(
                r#"{{"event":"{BRIDGE_EVENT}","payload":{{"_tag":"SniffingComplete"}}}}"#
            ),
        };
        assert!(matches!(classify_event(&event), BridgeAction::Drop(_)));
    }

    /// Dispatch classification: the lifecycle events re-emit NOTHING. A hide
    /// keeps the sniff running in the background and a dispose follows the SPA's
    /// own terminal `SniffingComplete`, so neither fabricates a terminal event
    /// on the bus. This guards the behavioral change from the old
    /// `Closed → SniffingComplete` re-emit.
    #[test]
    fn lifecycle_events_classify_as_no_emit() {
        assert!(matches!(
            classify_event(&NativeWebviewEvent::Hidden),
            BridgeAction::Lifecycle(_)
        ));
        assert!(matches!(
            classify_event(&NativeWebviewEvent::Disposed),
            BridgeAction::Lifecycle(_)
        ));
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
