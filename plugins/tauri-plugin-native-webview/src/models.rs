//! Wire shapes shared between the Rust command layer and the native (Swift /
//! Kotlin) plugin. `OpenRequest` is what crosses `run_mobile_plugin("openUrl", …)`;
//! `OpenResponse` is what the native side resolves back. Field names are
//! `camelCase` on the wire to match the Swift `Decodable` / Kotlin `@InvokeArg`
//! sides.
//!
//! Native webview events flow the other direction (native → Rust) through a Tauri
//! [`Channel`] embedded in `OpenRequest` — see [`NativeWebviewEvent`]. The mobile
//! plugin side (`NativeWebviewPlugin.swift` / `NativeWebviewPlugin.kt`) sends
//! `{event,…}` payloads through the channel; Rust deserialises them and
//! dispatches to the caller's handler. This replaces an earlier JS-side
//! `addPluginListener('message')` path so the bridge can stay entirely in Rust
//! (the sniffer routes events onto its own bus from a Rust handler).

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

/// Arguments for opening the native webview.
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
    /// payloads through (`message` events plus `hidden` / `disposed`). The same
    /// `Channel<NativeWebviewEvent>` instance can be reused across many `open`
    /// calls — its identifier is preserved on `Clone`, so a long-lived channel
    /// registered at app start receives events from every native webview it opens.
    pub native_webview_event_channel: Channel<NativeWebviewEvent>,
    /// Chrome title applied at presentation time. `None` falls back to the URL
    /// host. Applying chrome through `open` (rather than a post-open
    /// `patch_window_text`) means the native webview's first paint already shows it — and
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

/// Result of an `open` invocation. `opened` is `true` once the native webview
/// has been presented (the load itself proceeds asynchronously).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpenResponse {
    /// Whether the native webview was presented.
    pub opened: bool,
}

/// Events the native (Swift / Kotlin) webview sends to its Rust caller through
/// the [`Channel`] embedded in [`OpenRequest`].
///
/// Internally tagged on `event` (`{"event":"message","payload":"…"}` /
/// `{"event":"hidden"}` / `{"event":"disposed"}`) — the variant tags are pinned
/// lowercase here so the Swift/Kotlin `channel.send([...])` callsites can
/// hand-roll the dictionary without a generated `Codable`/`@Serializable`
/// companion. Drift between the variant names and what the native sides emit
/// would silently swallow events at deserialise time (the round-trip tests
/// below guard the wire shape).
///
/// Lifecycle: the native webview is presented by `open`, **hidden** (removed
/// from view but kept alive and running) by a user dismissal or a host `hide`,
/// and **disposed** (torn down, resources freed) only by a host `dispose` or the
/// teardown backstop. Visibility, liveness, and existence are independent:
/// hiding is not a teardown, so a hidden webview keeps executing until disposed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "event")]
pub enum NativeWebviewEvent {
    /// A `WKScriptMessageHandler` / `@JavascriptInterface` postMessage from
    /// the native webview. `payload` is the raw string the page posted — the
    /// plugin is content-agnostic and forwards it verbatim.
    #[serde(rename = "message")]
    Message {
        /// The opaque page-posted body, typically a JSON envelope the caller
        /// parses on its own bus.
        payload: String,
    },
    /// The native webview was **hidden** — removed from view but kept alive and
    /// running. Fired for user dismissals (iOS Close button or sheet swipe,
    /// Android Toolbar back / system back, desktop window X) and for a host
    /// `hide()`. The webview keeps executing (timers, network, the caller's
    /// injected script); nothing is torn down. A later `open` re-presents the
    /// same live instance.
    #[serde(rename = "hidden")]
    Hidden,
    /// The native webview was **disposed** — torn down and its resources
    /// (WebView, bridge, channel binding) freed. Fired for a host `dispose()`
    /// (the caller is done with it) and for the teardown backstop (app teardown
    /// or the hidden-idle timeout). Terminal: the instance no longer exists, so
    /// a subsequent `open` builds a fresh one.
    #[serde(rename = "disposed")]
    Disposed,
}

/// Arguments for evaluating JavaScript in the currently-open native webview.
///
/// `script` is handed verbatim to the platform's evaluate-JS API
/// (`WKWebView.evaluateJavaScript` on iOS, `WebView.evaluateJavascript` on
/// Android, `Webview::eval` on desktop). Caller-trusted; the plugin does not
/// sandbox or wrap it. Returns an error if no native webview is currently open.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EvaluateJsRequest {
    /// JS source to evaluate inside the native webview.
    pub script: String,
}

/// Result of an `evaluate_js` invocation. `was_dispatched` is `true` once the
/// script has been queued for evaluation on the native webview's thread (the
/// evaluation itself is asynchronous; the plugin does not surface its return
/// value).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EvaluateJsResponse {
    /// Whether the script was dispatched to the native webview.
    pub was_dispatched: bool,
}

/// Arguments for updating the native webview's three chrome labels. Each field is
/// independent:
///
/// - `title` — top-chrome headline. Until the caller first sets it, the slot
///   shows the page URL (the URL-fallback), which tracks navigation; the first
///   `title` the caller supplies *claims* the slot and the URL falls through to
///   the subtitle.
/// - `subtitle` — top-chrome secondary line under the title. Shows the page URL
///   once the title is claimed but the subtitle isn't; the caller's first
///   `subtitle` claims it and the URL is then shown in neither slot.
/// - `message` — bottom-bar status line beside the back/forward buttons.
///
/// `None` on any field means "leave unchanged"; any present value (including
/// `Some("")`) claims that slot — `Some("")` clears the visible label.
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
/// been applied to the native webview's chrome (synchronous on the UI thread); `false`
/// when no native webview is open (not a hard error — the caller may push speculatively
/// across the native webview lifecycle without a retry dance).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PatchWindowTextResponse {
    /// Whether the update was applied to a live native webview chrome.
    pub set: bool,
}

/// Result of a `show` invocation. `shown` is `true` once a live native webview
/// (freshly created or previously hidden) was presented; `false` when none
/// exists to show. Visibility is independent of content: `open_url` navigates
/// without presenting, and `show` presents without navigating.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShowResponse {
    /// Whether this call presented a live native webview. `false` when none
    /// exists.
    pub shown: bool,
}

/// Result of a `hide` invocation. `hidden` is `true` once a live, visible native
/// webview was removed from view (kept alive and running); `false` when none was
/// visible. Idempotent: hiding an already-hidden / absent native webview
/// succeeds with `hidden: false`. A successful hide emits
/// [`NativeWebviewEvent::Hidden`] on the channel.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HideResponse {
    /// Whether this call hid a live, visible native webview. `false` when none
    /// was visible.
    pub hidden: bool,
}

/// Result of a `dispose` invocation. `disposed` is `true` once a live native
/// webview (visible or hidden) was torn down and its resources freed; `false`
/// when none existed. Idempotent: disposing an absent native webview succeeds
/// with `disposed: false`. A successful dispose emits
/// [`NativeWebviewEvent::Disposed`] on the channel.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DisposeResponse {
    /// Whether this call tore down a live native webview. `false` when none
    /// existed.
    pub disposed: bool,
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
    /// status paints with the native webview instead of via a post-open `patch_window_text`.
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
    /// the Swift `EvaluateJsArgs.script` / Kotlin `EvaluateJsArgs.script` field.
    /// Drift here would silently break decoding on-device.
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
    /// post-open call updates `subtitle` (and later `message`) without touching
    /// `title`, which is left unclaimed so the page URL shows there.
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
    fn native_webview_event_message_round_trips_with_lowercase_tag() {
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

    /// `NativeWebviewEvent::Hidden` decodes from `{ "event":"hidden" }` — no
    /// payload. The native sides emit this on a user dismissal or host `hide`.
    #[test]
    fn native_webview_event_hidden_decodes_without_payload() {
        let event: NativeWebviewEvent = serde_json::from_str(r#"{"event":"hidden"}"#).expect("de");
        assert_eq!(event, NativeWebviewEvent::Hidden);
        assert_eq!(
            serde_json::to_string(&event).expect("ser"),
            r#"{"event":"hidden"}"#
        );
    }

    /// `NativeWebviewEvent::Disposed` decodes from `{ "event":"disposed" }` — no
    /// payload. Emitted on a host `dispose` or the teardown backstop.
    #[test]
    fn native_webview_event_disposed_decodes_without_payload() {
        let event: NativeWebviewEvent =
            serde_json::from_str(r#"{"event":"disposed"}"#).expect("de");
        assert_eq!(event, NativeWebviewEvent::Disposed);
        assert_eq!(
            serde_json::to_string(&event).expect("ser"),
            r#"{"event":"disposed"}"#
        );
    }

    /// `ShowResponse` decodes both arms of the native-side `{ "shown": … }`
    /// payload — `true` when a live native webview was presented, `false` when
    /// none existed to show.
    #[test]
    fn show_response_decodes_shown_flag() {
        let live: ShowResponse = serde_json::from_str(r#"{"shown":true}"#).expect("de");
        assert!(live.shown);
        let none: ShowResponse = serde_json::from_str(r#"{"shown":false}"#).expect("de");
        assert!(!none.shown);
    }

    /// `HideResponse` decodes both arms of the native-side `{ "hidden": … }`
    /// payload — `true` when a visible native webview was hidden, `false` when
    /// none was visible (idempotent hide).
    #[test]
    fn hide_response_decodes_hidden_flag() {
        let live: HideResponse = serde_json::from_str(r#"{"hidden":true}"#).expect("de");
        assert!(live.hidden);
        let already: HideResponse = serde_json::from_str(r#"{"hidden":false}"#).expect("de");
        assert!(!already.hidden);
    }

    /// `DisposeResponse` decodes both arms of the native-side `{ "disposed": … }`
    /// payload — `true` when a live native webview was torn down, `false` when
    /// none existed (idempotent dispose).
    #[test]
    fn dispose_response_decodes_disposed_flag() {
        let live: DisposeResponse = serde_json::from_str(r#"{"disposed":true}"#).expect("de");
        assert!(live.disposed);
        let already: DisposeResponse = serde_json::from_str(r#"{"disposed":false}"#).expect("de");
        assert!(!already.disposed);
    }
}
