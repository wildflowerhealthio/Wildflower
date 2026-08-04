//! Rust-side bridge between `tauri-plugin-native-webview`'s native webview and
//! the sniffer's `SnifferEvents` stream (fanned out to clients by
//! `browser-sniffer-rust`'s `/sniffer/events` WebSocket). See
//! [`Tauri Host Explanation.md`](../../docs/Tauri%20Host%20Explanation.md) for
//! the full data-plane / transport plumbing.
//!
//! - **Native webview → host** ([`install`]): a long-lived
//!   `Channel<NativeWebviewEvent>` decodes each plugin event and publishes it
//!   into `SnifferEvents`. `Message` is validated
//!   ([`validate_native_webview_message`]) and its inner payload forwarded;
//!   `Hidden` is synthesized into a host-origin `UserDismissed` lifecycle
//!   event, and `Disposed` into a `SnifferDisposed` one. `Hidden` is the
//!   user-dismissal signal *in practice* — see `classify_event` for the caveat
//!   that a programmatic `hide()` would also emit it. The two stay separate
//!   tags because a dispose is also the normal outcome of the client-driven
//!   `DELETE /sniffer/webview` teardown, so it arrives on every run and the
//!   client must be able to tell it apart from a user's dismissal. The channel
//!   is cloned and reused across opens — `Clone` preserves the handler, so it
//!   fires for every native webview.
//! - **Host → native webview** ([`forward_to_native_webview`]): the
//!   `evaluate_js` forward the `SnifferWebviewHandle::forward_to_page` port
//!   op rides, on **every** platform (the retired bridge had a desktop
//!   direct-bus path; HTTP clients have no bus, so desktop now forwards the
//!   same way mobile always did).
//! - **Desktop data plane**: the content webview holds no bus grant at all;
//!   its web→host stream rides the [`native_webview_data_plane_emit`]
//!   command — the desktop counterpart of the mobile `Message` allowlist gate.

use std::borrow::Cow;
use std::fmt;

use browser_sniffer_rust::domain::events as event_tags;
use browser_sniffer_rust::SnifferEvents;
use serde::de::{self, MapAccess, Visitor};
use serde::Deserialize;
use serde_json::value::RawValue;
use shared_structures_rust::bridge::BRIDGE_EVENT;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager};
use tauri_plugin_log::log;
use tauri_plugin_native_webview::NativeWebviewEvent;

/// The web→host data-plane tags the sniffer's native-webview page may raise.
/// Sourced from `browser-sniffer-rust`'s tag constants — the same strings the
/// WebSocket contract is pinned to — so the gate and the stream can't drift.
/// Control/lifecycle tags are deliberately excluded so an untrusted page can't
/// spoof them; [`tests::data_plane_tags_match_ts`] drift-guards the literals.
const NATIVE_WEBVIEW_DATA_PLANE_TAGS: &[&str] = &[
    event_tags::PAGE_LOADED,
    event_tags::RESPONSE_START,
    event_tags::RESPONSE_DATA,
    event_tags::RESPONSE_FINISHED,
    event_tags::REQUEST_ERROR,
    event_tags::CANCELLED,
    event_tags::LOG,
];

/// Managed state wrapping the [`Channel`] handed to each plugin `open` call.
///
/// `Clone` on `Channel<T>` preserves the underlying handler (`Arc<ChannelInner>`),
/// so the same handler fires no matter which native webview sent the event.
/// Stored in Tauri's typemap, retrieved by `sniffer_window::open_or_navigate`.
pub(crate) struct NativeWebviewChannel {
    pub(crate) channel: Channel<NativeWebviewEvent>,
}

/// Managed state carrying the `SnifferEvents` publisher for the desktop
/// data-plane command (which only receives an `AppHandle`).
struct ManagedSnifferEvents {
    events: SnifferEvents,
}

/// Build the channel, register its handler, and stash the
/// [`NativeWebviewChannel`] + the events publisher on the app. Call once from
/// `attach_browser_sniffer`.
pub(crate) fn install(app: &AppHandle, events: SnifferEvents) {
    let channel_events = events.clone();
    let channel: Channel<NativeWebviewEvent> = Channel::new(move |body| {
        dispatch_body(&channel_events, &body);
        Ok(())
    });
    app.manage(NativeWebviewChannel { channel });
    app.manage(ManagedSnifferEvents { events });
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
/// *any* key, not just `_tag`: this guard re-publishes the raw bytes verbatim,
/// so it must never accept bytes that last-wins serde and a first-wins
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
/// payload to publish verbatim into the event stream, or an `Err` describing
/// why it was dropped (logged at warn by the caller).
///
/// Security (the mobile path's load-bearing guard; desktop's counterpart is
/// [`data_plane_value_is_allowed`]): the native webview hosts an arbitrary
/// third-party page that can reach the native bridge directly, so both the
/// envelope `event` and the inner `_tag` are attacker-controlled. We require the
/// envelope target `BRIDGE_EVENT` AND the inner `_tag` be an allowlisted
/// data-plane tag ([`NATIVE_WEBVIEW_DATA_PLANE_TAGS`]) — publishing anything
/// else would let a hostile page fabricate a data event or forge the
/// host-synthesized `UserDismissed` / `SnifferDisposed` lifecycle signals
/// (cutting an `AwaitUserDismiss` hold short).
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
/// factored out so the dispatch decision is unit-testable without a channel. A
/// `Publish` borrows its payload from the event it was decoded from, so the
/// lifetime ties the two together.
#[derive(Debug)]
enum BridgeAction<'a> {
    /// Publish this inner payload verbatim into the event stream.
    Publish(&'a RawValue),
    /// Drop a `Message` that failed envelope / allowlist validation; the `Cow`
    /// is the warn-logged reason.
    Drop(Cow<'static, str>),
    /// Synthesize a host-origin lifecycle event `{"_tag": tag}` and publish it.
    /// Used for the `Hidden` → `UserDismissed` and `Disposed` →
    /// `SnifferDisposed` signals — the payload is host-generated, not forwarded
    /// from the page.
    PublishLifecycle(&'static str),
}

/// Decide what to do with a decoded native-webview event. Pure (no channel, no
/// I/O) so the security-critical `Message` validation and the lifecycle arms
/// are unit-testable; [`dispatch_body`] performs the effects.
fn classify_event(event: &NativeWebviewEvent) -> BridgeAction<'_> {
    match event {
        NativeWebviewEvent::Message { payload } => match validate_native_webview_message(payload) {
            Ok(inner_payload) => BridgeAction::Publish(inner_payload),
            Err(reason) => BridgeAction::Drop(reason),
        },
        // A `Hidden` is surfaced to the client as `UserDismissed` so an
        // `AwaitUserDismiss` step can stop waiting. It is the user-dismissal signal
        // *in practice* (desktop titlebar X / iOS Close/swipe / Android back →
        // `prevent_close` + `hide`; see plugin `lifecycle.rs`) — but note the
        // plugin's programmatic `hide()` command also emits `Hidden`, so this is a
        // faithful "user closed it" signal only because nothing calls `hide()` on
        // the `SNIFFER_WEBVIEW_ID` instance.
        NativeWebviewEvent::Hidden => BridgeAction::PublishLifecycle(event_tags::USER_DISMISSED),
        // A `Disposed` is surfaced as its own `SnifferDisposed` tag rather than
        // folded into `UserDismissed`: the client's own `DELETE /sniffer/webview`
        // teardown disposes the webview, so one arrives on every run. Kept
        // distinct, the client can ignore it except while an `AwaitUserDismiss`
        // step is waiting on a window that no longer exists.
        NativeWebviewEvent::Disposed => {
            BridgeAction::PublishLifecycle(event_tags::SNIFFER_DISPOSED)
        }
    }
}

/// Decode a channel body and publish into the event stream. Decode failures
/// log at warn — native-webview event delivery is best-effort, the listener
/// loop continues.
fn dispatch_body(events: &SnifferEvents, body: &InvokeResponseBody) {
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
        BridgeAction::Publish(inner_payload) => {
            events.publish(inner_payload.get().to_owned());
        }
        BridgeAction::Drop(reason) => {
            log::warn!("[browser-sniffer] native-webview message dropped: {reason}");
        }
        BridgeAction::PublishLifecycle(tag) => {
            events.publish_lifecycle(tag);
            // These tags are the host's only trace of a webview lifecycle
            // transition, and "did the host see the dismissal and publish it?"
            // has to be answerable from a log when a run ends earlier or later
            // than a user expected.
            log::debug!("[browser-sniffer] published host lifecycle `{tag}`");
        }
    }
}

/// Forward a tagged bridge envelope (`{"_tag":"PageAction",…}` /
/// `{"_tag":"CancelSnifferRequest",…}`) into the native webview as a
/// `window.__nativeWebviewReceive(...)` call — the
/// `SnifferWebviewHandle::forward_to_page` port op, identical on every
/// platform (both bootstraps install the receiver; see
/// `browser-sniffer-tauri`'s `native-bridge.ts`).
///
/// `envelope_json` is re-wrapped in `{"event":"bridge","payload":<envelope>}`
/// to match the page-side `parseEnvelope`.
///
/// # Errors
///
/// A malformed envelope or a plugin failure. A **missing webview is `Ok`**:
/// the collector cancels speculatively during teardown, so "no native webview
/// open" is a benign no-op, not a failure the client can act on.
pub(crate) fn forward_to_native_webview(
    app: &AppHandle,
    envelope_json: &str,
) -> anyhow::Result<()> {
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
    let payload: &RawValue = serde_json::from_str(envelope_json)
        .map_err(|error| anyhow::anyhow!("undecodable forward envelope: {error}"))?;
    let envelope = serde_json::to_string(&OutboundEnvelope {
        event: BRIDGE_EVENT,
        payload,
    })
    .map_err(|error| anyhow::anyhow!("failed to encode forward envelope: {error}"))?;
    // Two-stage stringify: `envelope` is what the page-side receiver parses;
    // quoting it as a JS string literal escapes quotes/backslashes that would
    // otherwise syntax-error the injected `evaluateJavaScript` script.
    let quoted_envelope = serde_json::Value::String(envelope).to_string();
    let script = format!("window.__nativeWebviewReceive({quoted_envelope})");

    if let Err(error) = app
        .native_webview()
        .evaluate_js(crate::SNIFFER_WEBVIEW_ID, EvaluateJsRequest { script })
    {
        // Two failure modes hide behind one reject, and the plugin's error
        // carries only a string — match it. The collector cancels
        // speculatively, so a closed webview is benign/expected (debug-log,
        // `Ok`); anything else dropped a real action and is the caller's 500.
        // Mobile spells it "no native webview open", desktop "no
        // native-webview open".
        let message = error.to_string();
        if message.contains("no native webview open") || message.contains("no native-webview open")
        {
            log::debug!(
                "[browser-sniffer] forward_to_page: no native webview open (expected for a \
                 speculative Cancel): {error}"
            );
            return Ok(());
        }
        return Err(anyhow::anyhow!(
            "tauri-plugin-native-webview evaluate_js failed: {error}"
        ));
    }
    Ok(())
}

/// Validate a desktop content-webview data-plane payload before publishing it
/// into the event stream. The inner `_tag` must be allowlisted
/// ([`NATIVE_WEBVIEW_DATA_PLANE_TAGS`]) — the same gate mobile's
/// [`validate_native_webview_message`] applies.
///
/// This validates a parsed [`serde_json::Value`] and publishes that *same*
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
/// so it is **not** trusted with any event-bus grant:
/// `capabilities/native-webview-window.json` allows only this command, which
/// allowlists the inner `_tag` ([`data_plane_value_is_allowed`]) before
/// publishing into the sniffer event stream — the desktop counterpart of the
/// mobile [`validate_native_webview_message`] gate.
///
/// Best-effort: a rejected payload is logged at warn and dropped. Registered
/// unconditionally in the app's `invoke_handler`, but desktop-only in
/// practice — mobile's native webview can't reach Tauri commands.
#[tauri::command]
pub fn native_webview_data_plane_emit(app: AppHandle, payload: serde_json::Value) {
    match data_plane_value_is_allowed(&payload) {
        Ok(()) => match serde_json::to_string(&payload) {
            // `try_state`, not `state`: the command is registered
            // unconditionally in the app's `invoke_handler` while the publisher
            // is only managed by `attach_browser_sniffer`. A panic here would
            // take down the invoke task; a dropped event with a warn matches
            // the rest of this command's best-effort contract.
            Ok(json) => match app.try_state::<ManagedSnifferEvents>() {
                Some(events) => events.events.publish(json),
                None => log::warn!(
                    "[browser-sniffer] desktop native-webview data-plane emit dropped: the \
                     sniffer event stream is not managed (attach_browser_sniffer never ran)"
                ),
            },
            Err(error) => {
                log::warn!(
                    "[browser-sniffer] desktop native-webview data-plane re-serialize failed: \
                     {error}"
                );
            }
        },
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
    use browser_sniffer_rust::domain::events as event_tags;

    /// The control/lifecycle tags an untrusted page must never be able to
    /// raise: the five retired bridge control verbs (now REST endpoints, kept
    /// here as spoof probes — a page replaying old bridge traffic still gets
    /// dropped) and the two host-synthesized lifecycle tags.
    const SPOOFED_CONTROL_TAGS: &[&str] = &[
        "SniffingComplete",
        "Open",
        "RequestSniffableWebView",
        "SetSnifferStatus",
        "EnsureSnifferVisible",
        event_tags::USER_DISMISSED,
        event_tags::SNIFFER_DISPOSED,
    ];

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
    /// data-plane tag returns the inner payload verbatim for publishing.
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

    /// Security: a control/lifecycle tag the page must NOT be able to raise
    /// (it could prematurely end sniffing or cut an `AwaitUserDismiss` hold
    /// short) is rejected even though the envelope targets the right channel.
    #[test]
    fn spoofed_control_tag_is_rejected() {
        for tag in SPOOFED_CONTROL_TAGS {
            let json = format!(r#"{{"event":"{BRIDGE_EVENT}","payload":{{"_tag":"{tag}"}}}}"#);
            assert!(
                validate_native_webview_message(&json).is_err(),
                "control tag `{tag}` must not be published from a native-webview message"
            );
        }
    }

    /// An envelope targeting a different event name is refused — the sniffer
    /// page only ever speaks the bridge envelope shape.
    #[test]
    fn unexpected_event_name_is_rejected() {
        let json = r#"{"event":"some-other-event","payload":{"_tag":"ResponseData"}}"#;
        assert!(validate_native_webview_message(json).is_err());
    }

    /// A missing or explicit-null `payload` is dropped as malformed rather
    /// than publishing `null` into the stream.
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
    /// (serde last-wins) could otherwise disagree with the verbatim-published
    /// bytes a first-wins downstream reader sees — a duplicate `_tag` whose first
    /// occurrence is a rejected control tag must not slip past the allowlist. We
    /// reject any duplicate key so the published bytes are never attacker-shaped.
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
    /// a hostile content webview can't reach the command to forge them into the
    /// stream — the desktop counterpart of the mobile spoof-rejection guard.
    #[test]
    fn desktop_data_plane_rejects_spoofed_control_tags() {
        for tag in SPOOFED_CONTROL_TAGS {
            let payload = serde_json::json!({ "_tag": tag });
            assert!(
                data_plane_value_is_allowed(&payload).is_err(),
                "control tag `{tag}` must not be publishable through the desktop command"
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
    /// tag publishes its inner payload verbatim (the load-bearing forward path).
    #[test]
    fn message_with_allowlisted_tag_classifies_as_publish() {
        let event = NativeWebviewEvent::Message {
            payload: format!(
                r#"{{"event":"{BRIDGE_EVENT}","payload":{{"_tag":"ResponseData","id":"r1"}}}}"#
            ),
        };
        match classify_event(&event) {
            BridgeAction::Publish(inner) => {
                assert_eq!(inner.get(), r#"{"_tag":"ResponseData","id":"r1"}"#);
            }
            other => panic!("expected Publish, got {other:?}"),
        }
    }

    /// Dispatch classification: a `Message` carrying a spoofed control tag is
    /// dropped, never published — the security allowlist reached through the
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

    /// Dispatch classification: a `Hidden` (the user closing/dismissing the
    /// sniffer window) is surfaced to the client as a host-origin
    /// `UserDismissed` lifecycle event, carrying exactly that tag.
    #[test]
    fn hidden_classifies_as_user_dismissed_lifecycle() {
        assert!(matches!(
            classify_event(&NativeWebviewEvent::Hidden),
            BridgeAction::PublishLifecycle(event_tags::USER_DISMISSED)
        ));
    }

    /// Dispatch classification: a `Disposed` (the sniffer webview torn down) is
    /// surfaced as its own `SnifferDisposed` lifecycle event — NOT as
    /// `UserDismissed`. The client's own `DELETE /sniffer/webview` teardown
    /// disposes the webview, so one arrives on every run; conflating the two
    /// tags would make ordinary shutdown indistinguishable from the user
    /// closing the window.
    #[test]
    fn disposed_classifies_as_sniffer_disposed_lifecycle() {
        assert!(matches!(
            classify_event(&NativeWebviewEvent::Disposed),
            BridgeAction::PublishLifecycle(event_tags::SNIFFER_DISPOSED)
        ));
    }

    /// The two lifecycle signals carry distinct tags. Pinned explicitly because
    /// the whole point of the separation is that the client can tell a user's
    /// dismissal apart from teardown — a refactor that collapsed them would
    /// otherwise still satisfy both classification tests above.
    #[test]
    fn hidden_and_disposed_carry_distinct_tags() {
        assert_ne!(event_tags::USER_DISMISSED, event_tags::SNIFFER_DISPOSED);
    }

    /// Undecodable envelope JSON is an `Err`, not a panic. The channel handler
    /// must never panic — a panic would tear the long-lived channel down.
    #[test]
    fn malformed_envelope_is_dropped_not_panicked() {
        assert!(validate_native_webview_message("not-json").is_err());
        // `NativeWebviewEvent` itself still rejects junk at the outer decode layer.
        assert!(serde_json::from_str::<NativeWebviewEvent>("not-json").is_err());
        assert!(serde_json::from_str::<NativeWebviewEvent>(r#"{"event":"unknown"}"#).is_err());
    }
}
