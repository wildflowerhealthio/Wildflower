//! Wire shapes shared between the Rust command layer and the native (Swift /
//! Kotlin) plugin. `OpenRequest` is what crosses `run_mobile_plugin("open", …)`;
//! `OpenResponse` is what the native side resolves back. Field names are
//! `camelCase` on the wire to match the Swift `Decodable` / Kotlin `@InvokeArg`
//! sides.
//!
//! Popup events flow the other direction (native → Rust) through a Tauri
//! [`Channel`] embedded in `OpenRequest` — see [`NativeWebviewEvent`]. The mobile
//! plugin side (`NativeWebviewPlugin.swift` / `NativeWebviewPlugin.kt`) sends
//! `{event,…}` payloads through the channel; Rust deserialises them and
//! dispatches to the caller's handler. This replaces an earlier JS-side
//! `addPluginListener('message')` path so the bridge can stay entirely in Rust
//! (the sniffer routes events onto its own bus from a Rust handler).

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

/// Arguments for opening the native webview popup.
///
/// `OpenRequest` is `Serialize`-only (and so omits `PartialEq` / `Eq` /
/// `Deserialize`) because [`Channel`] only serialises one way — its on-wire
/// form is an opaque `"__CHANNEL__:<id>"` string the mobile-side
/// `Channel: Decodable` parses to wire up the send-back path. Round-tripping
/// the struct would require re-creating that handler, which is meaningless
/// outside an IPC context.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRequest {
    /// The external URL to load. Any `http(s)://` origin is accepted.
    pub url: String,
    /// JavaScript injected at **document start** into every page on **any**
    /// origin (the caller owns this — e.g. browser-sniffer's bundled
    /// `installSniffer` IIFE). `None` injects nothing; the plugin itself is
    /// content-agnostic.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub init_script: Option<String>,
    /// Channel the native (Swift / Kotlin) side sends [`NativeWebviewEvent`]
    /// payloads through (`message` events plus the eventual `closed`). The same
    /// `Channel<NativeWebviewEvent>` instance can be reused across many `open`
    /// calls — its identifier is preserved on `Clone`, so a long-lived channel
    /// registered at app start receives events from every popup it opens.
    pub native_webview_event_channel: Channel<NativeWebviewEvent>,
    /// Chrome title applied at presentation time. `None` falls back to the URL
    /// host. Applying chrome through `open` (rather than a post-open
    /// `patch_window_text`) means the popup's first paint already shows it — and
    /// avoids the desktop race where a `patch_window_text` fired right after `open`
    /// finds the chrome webview not yet built.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_title: Option<String>,
    /// Chrome subtitle applied at presentation time. `None` leaves it empty.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_subtitle: Option<String>,
    /// Chrome bottom-bar message applied at presentation time. `None` leaves it
    /// empty.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_message: Option<String>,
}

/// Result of an `open` invocation. `opened` is `true` once the native popup
/// has been presented (the load itself proceeds asynchronously).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpenResponse {
    /// Whether the native popup was presented.
    pub opened: bool,
}

/// Events the native (Swift / Kotlin) popup sends to its Rust caller through
/// the [`Channel`] embedded in [`OpenRequest`].
///
/// Internally tagged on `event` (`{"event":"message","payload":"…"}` /
/// `{"event":"closed"}`) — the variant tags are pinned lowercase here so the
/// Swift/Kotlin `channel.send([...])` callsites can hand-roll the dictionary
/// without a generated `Codable`/`@Serializable` companion. Drift between the
/// variant names and what the native sides emit would silently swallow events
/// at deserialise time (the round-trip test below guards the wire shape).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "event")]
pub enum NativeWebviewEvent {
    /// A `WKScriptMessageHandler` / `@JavascriptInterface` postMessage from
    /// the popup webview. `payload` is the raw string the page posted — the
    /// plugin is content-agnostic and forwards it verbatim.
    #[serde(rename = "message")]
    Message {
        /// The opaque page-posted body, typically a JSON envelope the caller
        /// parses on its own bus.
        payload: String,
    },
    /// The popup was dismissed. Sent once per popup, after the sheet / dialog /
    /// window has finished its dismiss animation. Fired for user dismissals
    /// (iOS Close button or sheet swipe, Android Toolbar back / system back,
    /// desktop OS window X) and for host-initiated `close()` calls — UNLESS the
    /// `close()` set [`CloseRequest::suppress_close_event`], in which case that
    /// one dismissal is silent (the host already observed the terminal event
    /// that prompted the close).
    #[serde(rename = "closed")]
    Closed,
}

/// Arguments for evaluating JavaScript in the currently-open native popup.
///
/// `script` is handed verbatim to the platform's evaluate-JS API
/// (`WKWebView.evaluateJavaScript` on iOS, `WebView.evaluateJavascript` on
/// Android, `Webview::eval` on desktop). Caller-trusted; the plugin does not
/// sandbox or wrap it. Returns an error if no popup is currently open.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EvaluateJsRequest {
    /// JS source to evaluate inside the popup webview.
    pub script: String,
}

/// Result of an `evaluate_js` invocation. `was_dispatched` is `true` once the
/// script has been queued for evaluation on the popup's webview thread (the
/// evaluation itself is asynchronous; the plugin does not surface its return
/// value).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EvaluateJsResponse {
    /// Whether the script was dispatched to the popup webview.
    pub was_dispatched: bool,
}

/// Arguments for updating the popup's three chrome labels. Each field is
/// independent:
///
/// - `title` — top-chrome headline (defaults to the URL host on open; the
///   plugin does not auto-update on navigation, so the caller drives any
///   subsequent changes).
/// - `subtitle` — top-chrome secondary line under the title.
/// - `message` — bottom-bar status line beside the back/forward buttons.
///
/// `None` on any field means "leave unchanged"; `Some("")` clears that field.
/// Batching all three into one IPC keeps multi-field updates flicker-free.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PatchWindowTextRequest {
    /// Top-chrome headline. `None` = no change, `Some("")` = clear.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Top-chrome secondary line under the title. Same semantics as `title`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    /// Bottom-bar status text alongside the back/forward buttons. Same
    /// semantics as `title`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// Result of a `patch_window_text` invocation. `set` is `true` once the labels have
/// been applied to the popup's chrome (synchronous on the UI thread); `false`
/// when no popup is open (not a hard error — the caller may push speculatively
/// across the popup lifecycle without a retry dance).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PatchWindowTextResponse {
    /// Whether the update was applied to a live popup chrome.
    pub set: bool,
}

/// Arguments for a `close` invocation.
///
/// `suppress_close_event` lets a *host-initiated* close opt out of the
/// `NativeWebviewEvent::Closed` echo: the caller that issued the close already observed
/// the terminal event that triggered it (e.g. the browser-sniffer's
/// `SniffingComplete`), so re-emitting `Closed` on the channel would double-fire
/// the terminal observation. User / OS dismissals (the native chrome Close
/// button, a sheet swipe, the OS window X) never set this — those are the only
/// way the host learns of a dismissal, so they always emit `Closed`. JS
/// `invoke('plugin:native-webview|close')` callers get the default `false`.
///
/// Serialised camelCase (`suppressCloseEvent`) so the Swift / Kotlin
/// `parseArgs` callsites and the Rust mobile `run_mobile_plugin` payload agree
/// on the wire shape.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CloseRequest {
    /// When `true`, the dismissal this close triggers does NOT emit
    /// `NativeWebviewEvent::Closed` on the channel. Defaults to `false` (emit), so a
    /// caller that doesn't care keeps the symmetric "every close emits" posture.
    #[serde(default)]
    pub suppress_close_event: bool,
}

/// Result of a `close` invocation. `closed_by_request` is `true` once the
/// dismiss has been dispatched to the popup's view controller / dialog; `false`
/// when no popup was open. Idempotent: a `close` against an already-dismissed
/// popup succeeds with `closed_by_request: false`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloseResponse {
    /// Whether this call dismissed a live popup (i.e. the close happened
    /// because of this request). `false` when no popup was open.
    pub closed_by_request: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::ipc::Channel;

    /// Build a no-op `Channel<NativeWebviewEvent>` for shape-only ser tests where the
    /// channel's send-back path is irrelevant — the test only inspects the
    /// rest of the serialised payload by parsing it back as a generic JSON
    /// value (so the channel's `"__CHANNEL__:<id>"` string is ignored).
    fn noop_channel() -> Channel<NativeWebviewEvent> {
        Channel::new(|_| Ok(()))
    }

    /// With no init script, `OpenRequest` rides the wire as
    /// `{ "url": …, "channel": "__CHANNEL__:…" }` — `initScript` is omitted
    /// (not `null`) so the native `Decodable` / `@InvokeArg` optional decodes
    /// cleanly. Drift here would silently break decoding on-device.
    #[test]
    fn open_request_omits_absent_init_script() {
        let json = serde_json::to_string(&OpenRequest {
            url: "https://example.test/x".to_owned(),
            init_script: None,
            native_webview_event_channel: noop_channel(),
            initial_title: None,
            initial_subtitle: None,
            initial_message: None,
        })
        .expect("serialize");
        let parsed: serde_json::Value = serde_json::from_str(&json).expect("parse");
        let object = parsed.as_object().expect("object");
        assert_eq!(
            object.get("url").and_then(|v| v.as_str()),
            Some("https://example.test/x")
        );
        assert!(!object.contains_key("initScript"));
        // Absent initial-chrome fields are omitted (not `null`) so the native
        // `Decodable` / `@InvokeArg` optionals decode cleanly to "no change".
        assert!(!object.contains_key("initialTitle"));
        assert!(!object.contains_key("initialSubtitle"));
        assert!(!object.contains_key("initialMessage"));
        // Channel serialises as an opaque IPC handle string; we only check the
        // prefix to stay version-agnostic.
        assert!(object
            .get("nativeWebviewEventChannel")
            .and_then(|v| v.as_str())
            .is_some_and(|s| s.starts_with("__CHANNEL__:")));
    }

    /// The injected script rides under the camelCase `initScript` key.
    #[test]
    fn open_request_serializes_init_script_camel_case() {
        let json = serde_json::to_string(&OpenRequest {
            url: "https://example.test/x".to_owned(),
            init_script: Some("console.log(1)".to_owned()),
            native_webview_event_channel: noop_channel(),
            initial_title: None,
            initial_subtitle: None,
            initial_message: None,
        })
        .expect("serialize");
        let parsed: serde_json::Value = serde_json::from_str(&json).expect("parse");
        assert_eq!(
            parsed.get("initScript").and_then(|v| v.as_str()),
            Some("console.log(1)")
        );
    }

    /// Initial-chrome fields ride under their camelCase keys when set — the
    /// sniffer's `open` sets `initialSubtitle` so the "Collecting Automatically"
    /// status paints with the popup instead of via a post-open `patch_window_text`.
    #[test]
    fn open_request_serializes_initial_chrome_camel_case() {
        let json = serde_json::to_string(&OpenRequest {
            url: "https://example.test/x".to_owned(),
            init_script: None,
            native_webview_event_channel: noop_channel(),
            initial_title: None,
            initial_subtitle: Some("Collecting Automatically".to_owned()),
            initial_message: None,
        })
        .expect("serialize");
        let parsed: serde_json::Value = serde_json::from_str(&json).expect("parse");
        assert_eq!(
            parsed.get("initialSubtitle").and_then(|v| v.as_str()),
            Some("Collecting Automatically")
        );
        // Unset siblings stay omitted.
        let object = parsed.as_object().expect("object");
        assert!(!object.contains_key("initialTitle"));
        assert!(!object.contains_key("initialMessage"));
    }

    /// `OpenResponse` decodes the native-side `{ "opened": true }` payload.
    #[test]
    fn open_response_decodes_opened_flag() {
        let decoded: OpenResponse = serde_json::from_str(r#"{"opened":true}"#).expect("de");
        assert!(decoded.opened);
    }

    /// `EvaluateJsRequest` rides as `{ "script": … }` — the camelCase key matches
    /// the Swift `SendArgs.script` / Kotlin `SendArgs.script` field. Drift
    /// here would silently break decoding on-device.
    #[test]
    fn evaluate_js_request_serializes_script_field() {
        let json = serde_json::to_string(&EvaluateJsRequest {
            script: "window.x = 1".to_owned(),
        })
        .expect("serialize");
        assert_eq!(json, r#"{"script":"window.x = 1"}"#);
    }

    /// `EvaluateJsResponse` decodes the native-side `{ "wasDispatched": true }` payload.
    #[test]
    fn evaluate_js_response_decodes_was_dispatched_flag() {
        let decoded: EvaluateJsResponse =
            serde_json::from_str(r#"{"wasDispatched":true}"#).expect("de");
        assert!(decoded.was_dispatched);
    }

    /// `PatchWindowTextRequest` omits absent fields entirely (not `null`) so the
    /// Swift/Kotlin optionals decode cleanly into "no change". Sending all
    /// three as `None` is a no-op IPC.
    #[test]
    fn patch_window_text_request_omits_absent_fields() {
        let json = serde_json::to_string(&PatchWindowTextRequest {
            title: None,
            subtitle: None,
            message: None,
        })
        .expect("ser");
        assert_eq!(json, "{}");
    }

    /// Each field rides as its camelCase key when set. The sniffer's typical
    /// post-open call updates `subtitle` (and later `message`) without
    /// touching `title`, which the plugin defaulted to the URL host on open.
    #[test]
    fn patch_window_text_request_serializes_each_field_camel_case() {
        let json = serde_json::to_string(&PatchWindowTextRequest {
            title: Some("example.test".to_owned()),
            subtitle: Some("Collecting Automatically".to_owned()),
            message: Some("34 resources collected".to_owned()),
        })
        .expect("ser");
        // Use a structural check (parse back to Value) so this test isn't
        // brittle against serde's key ordering across versions.
        let parsed: serde_json::Value = serde_json::from_str(&json).expect("parse");
        assert_eq!(
            parsed.get("title").and_then(|v| v.as_str()),
            Some("example.test")
        );
        assert_eq!(
            parsed.get("subtitle").and_then(|v| v.as_str()),
            Some("Collecting Automatically")
        );
        assert_eq!(
            parsed.get("message").and_then(|v| v.as_str()),
            Some("34 resources collected")
        );
    }

    /// `PatchWindowTextResponse` decodes the native-side `{ "set": true }` payload.
    #[test]
    fn patch_window_text_response_decodes_set_flag() {
        let decoded: PatchWindowTextResponse = serde_json::from_str(r#"{"set":true}"#).expect("de");
        assert!(decoded.set);
    }

    /// `NativeWebviewEvent::Message` decodes from `{ "event":"message", "payload":… }`
    /// — what the Swift/Kotlin `channel.send([…])` calls emit. The variant
    /// tags are pinned lowercase; drift here would silently swallow events
    /// at the Rust handler.
    #[test]
    fn popup_event_message_round_trips_with_lowercase_tag() {
        let json = r#"{"event":"message","payload":"hello"}"#;
        let event: NativeWebviewEvent = serde_json::from_str(json).expect("de");
        assert_eq!(
            event,
            NativeWebviewEvent::Message {
                payload: "hello".to_owned()
            }
        );
        // Round-trip back to the same bytes (key-order stable for this tiny shape).
        assert_eq!(serde_json::to_string(&event).expect("ser"), json);
    }

    /// `NativeWebviewEvent::Closed` decodes from `{ "event":"closed" }` — no payload.
    #[test]
    fn popup_event_closed_decodes_without_payload() {
        let event: NativeWebviewEvent = serde_json::from_str(r#"{"event":"closed"}"#).expect("de");
        assert_eq!(event, NativeWebviewEvent::Closed);
        assert_eq!(
            serde_json::to_string(&event).expect("ser"),
            r#"{"event":"closed"}"#
        );
    }

    /// `CloseResponse` decodes both arms of the native-side
    /// `{ "closedByRequest": … }` payload — `true` for a live dismiss, `false`
    /// for an already-closed popup (idempotent close).
    #[test]
    fn close_response_decodes_closed_by_request_flag() {
        let live: CloseResponse =
            serde_json::from_str(r#"{"closedByRequest":true}"#).expect("de");
        assert!(live.closed_by_request);
        let already: CloseResponse =
            serde_json::from_str(r#"{"closedByRequest":false}"#).expect("de");
        assert!(!already.closed_by_request);
    }

    /// `CloseRequest` serialises the suppression flag as camelCase
    /// `suppressCloseEvent` — the wire key the Swift `CloseArgs` /
    /// Kotlin `CloseArgs` `parseArgs` callsites read. Drift here would make a
    /// host-initiated `close(true)` silently emit `Closed` anyway (the native
    /// side would decode the absent key as its `false` default).
    #[test]
    fn close_request_serialises_suppress_flag_camel_case() {
        let suppress = CloseRequest {
            suppress_close_event: true,
        };
        assert_eq!(
            serde_json::to_string(&suppress).expect("ser"),
            r#"{"suppressCloseEvent":true}"#
        );
    }

    /// An absent `suppressCloseEvent` decodes to `false` (the default), so a
    /// JS `invoke('…|close')` with no args — or any caller on the old wire
    /// shape — keeps the symmetric "every close emits `Closed`" posture.
    #[test]
    fn close_request_defaults_suppress_to_false() {
        let default: CloseRequest = serde_json::from_str("{}").expect("de");
        assert!(!default.suppress_close_event);
    }
}
