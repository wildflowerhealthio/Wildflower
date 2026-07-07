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
    /// payloads through. Its identifier is preserved on `Clone`, so a long-lived
    /// channel registered at app start can be reused across many `open` calls and
    /// receives events from every native webview it opens.
    pub native_webview_event_channel: Channel<NativeWebviewEvent>,
    /// Chrome title applied at presentation time; `None` falls back to the URL
    /// host. Setting chrome through `open` (rather than a post-open
    /// `patch_window_text`) paints it on first frame and avoids the desktop race
    /// where a `patch_window_text` right after `open` finds the chrome webview
    /// not yet built.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_title: Option<String>,
    /// Chrome subtitle applied at presentation time. `None` leaves it empty.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_subtitle: Option<String>,
    /// Chrome bottom-bar message applied at presentation time. `None` leaves it
    /// empty.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_message: Option<String>,
    /// Cookies written into the native webview's cookie store **before** the
    /// first navigation to `url`, so they ride the very first request (the apps
    /// launch path seeds the owner `wf_auth` session cookie this way — see the
    /// host's `native_webview_handle`). Empty means "seed nothing" and is
    /// omitted from the wire so the Swift/Kotlin optionals decode cleanly.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cookies: Vec<CookieSpec>,
}

/// One cookie to seed into the native webview's store, expressed as the
/// server-style attribute set (the same shape a `Set-Cookie` carries). Each
/// platform backend translates it to its native cookie API — desktop
/// `Webview::set_cookie`, iOS `HTTPCookie`, Android `CookieManager` — so the
/// fields stay API-neutral.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CookieSpec {
    /// Cookie name.
    pub name: String,
    /// Cookie value.
    pub value: String,
    /// `Domain` attribute — required, never optional: scopes the cookie to
    /// `domain` **and its subdomains** (standard `Domain` semantics on every
    /// backend). A domain-less cookie would be *silently dropped* by the
    /// desktop backend (wry hands WKHTTPCookieStore an empty-domain
    /// `HTTPCookie`, which never lands), so the spec forces callers to pick the
    /// host explicitly.
    pub domain: String,
    /// `Path` attribute (callers typically pass `/`).
    pub path: String,
    /// `Secure` attribute — https-only transport.
    pub secure: bool,
    /// `HttpOnly` attribute — invisible to page JS.
    pub http_only: bool,
    /// `SameSite` attribute.
    pub same_site: CookieSameSite,
    /// `Max-Age` in seconds from now; `None` makes it a session cookie.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_age: Option<i64>,
}

/// `SameSite` values for [`CookieSpec`], pinned lowercase on the wire
/// (`"strict"` / `"lax"` / `"none"`) for the Swift/Kotlin decoders.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CookieSameSite {
    /// Sent only on same-site requests.
    Strict,
    /// Sent on same-site requests and top-level cross-site navigations.
    Lax,
    /// Sent on all requests (requires `Secure`).
    None,
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
/// companion. Drift between these tags and what the native sides emit would
/// silently swallow events at deserialise time (the round-trip tests below
/// guard the wire shape).
///
/// Visibility, liveness, and existence are independent: hiding is not a
/// teardown, so a hidden webview keeps executing until disposed.
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

/// Arguments for updating the native webview's three chrome labels (`title` /
/// `subtitle` top-chrome, `message` bottom-bar). Each field is independent:
/// `None` = leave unchanged; any present value (including `Some("")`) *claims*
/// that slot, and `Some("")` clears the visible label. Claiming a slot stops the
/// page-URL fallback from painting there — see the Lifecycle & Races doc
/// § "Chrome URL-fallback". Batching all three into one IPC keeps multi-field
/// updates flicker-free.
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

/// Result of a `show` invocation.
///
/// `request_caused_show` is a *transition* flag (like its
/// [`HideResponse::request_caused_hide`] / [`DisposeResponse::request_caused_dispose`]
/// siblings), not a visibility state: `true` only when this call brought a live
/// instance to the foreground; `false` when nothing needed presenting (none
/// exists, mid-dispose, or *already* visible). Wire key `requestCausedShow`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShowResponse {
    /// Whether this call caused a live native webview to be presented. `false`
    /// when nothing needed presenting (none exists, or it was already visible).
    pub request_caused_show: bool,
}

/// Result of a `hide` invocation.
///
/// `request_caused_hide` is a *transition* flag (see [`ShowResponse`]): `true`
/// only when this call hid a live, *visible* instance; `false` when nothing was
/// visible to hide (none, or already hidden). A `true` result emits
/// [`NativeWebviewEvent::Hidden`] on the channel. Wire key `requestCausedHide`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HideResponse {
    /// Whether this call caused a live, visible native webview to be hidden.
    /// `false` when nothing was visible to hide.
    pub request_caused_hide: bool,
}

/// Result of a `dispose` invocation.
///
/// `request_caused_dispose` is a *transition* flag (see [`ShowResponse`]): `true`
/// only when this call tore down a live instance (visible or hidden) and freed
/// its resources; `false` when none existed. A `true` result emits
/// [`NativeWebviewEvent::Disposed`] on the channel. Wire key `requestCausedDispose`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DisposeResponse {
    /// Whether this call caused a live native webview to be torn down. `false`
    /// when none existed.
    pub request_caused_dispose: bool,
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
            cookies: vec![],
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
        // No cookies to seed → the key is omitted entirely, same rationale.
        assert!(!object.contains_key("cookies"));
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
            cookies: vec![],
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
            cookies: vec![],
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

    /// Cookies ride under the camelCase `cookies` key with each spec's fields
    /// camelCased (`httpOnly`, `sameSite`, `maxAge`) and the `SameSite` value
    /// pinned lowercase — the exact shape the Swift `Decodable` / Kotlin
    /// `@InvokeArg` sides parse. Drift here would silently break on-device
    /// cookie seeding (the popup would just look unauthenticated).
    #[test]
    fn open_request_serializes_cookies_camel_case() {
        let json = serde_json::to_string(&OpenRequest {
            url: "https://apex.example.test/x".to_owned(),
            init_script: None,
            native_webview_event_channel: noop_channel(),
            initial_title: None,
            initial_subtitle: None,
            initial_message: None,
            cookies: vec![CookieSpec {
                name: "wf_auth".to_owned(),
                value: "e.y.J".to_owned(),
                domain: "apex.example.test".to_owned(),
                path: "/".to_owned(),
                secure: true,
                http_only: true,
                same_site: CookieSameSite::Lax,
                max_age: Some(3600),
            }],
        })
        .expect("serialize");
        let parsed: serde_json::Value = serde_json::from_str(&json).expect("parse");
        assert_eq!(
            parsed.get("cookies"),
            Some(&serde_json::json!([{
                "name": "wf_auth",
                "value": "e.y.J",
                "domain": "apex.example.test",
                "path": "/",
                "secure": true,
                "httpOnly": true,
                "sameSite": "lax",
                "maxAge": 3600,
            }]))
        );
    }

    /// A session cookie (no `Max-Age`) omits the key — the Swift/Kotlin
    /// optionals decode absence as "unset", never `null`.
    #[test]
    fn cookie_spec_omits_absent_max_age() {
        let json = serde_json::to_string(&CookieSpec {
            name: "n".to_owned(),
            value: "v".to_owned(),
            domain: "example.test".to_owned(),
            path: "/".to_owned(),
            secure: false,
            http_only: false,
            same_site: CookieSameSite::Strict,
            max_age: None,
        })
        .expect("serialize");
        let parsed: serde_json::Value = serde_json::from_str(&json).expect("parse");
        let object = parsed.as_object().expect("object");
        assert!(!object.contains_key("maxAge"));
        assert_eq!(
            object.get("sameSite").and_then(|v| v.as_str()),
            Some("strict")
        );
    }

    /// `OpenResponse` decodes the native-side `{ "opened": true }` payload.
    #[test]
    fn open_response_decodes_opened_flag() {
        let decoded: OpenResponse = serde_json::from_str(r#"{"opened":true}"#).expect("de");
        assert!(decoded.opened);
    }

    /// `EvaluateJsRequest` rides as `{ "script": … }` — the camelCase key matches
    /// the Swift / Kotlin `EvaluateJsArgs.script` field (drift breaks on-device
    /// decoding).
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

    /// `ShowResponse` decodes both arms of the native-side
    /// `{ "requestCausedShow": … }` payload — `true` when this call presented a
    /// live native webview, `false` when none existed or it was already visible.
    /// The `requestCausedShow` wire key must match the Swift/Kotlin emit.
    #[test]
    fn show_response_decodes_request_caused_show_flag() {
        let live: ShowResponse = serde_json::from_str(r#"{"requestCausedShow":true}"#).expect("de");
        assert!(live.request_caused_show);
        let none: ShowResponse =
            serde_json::from_str(r#"{"requestCausedShow":false}"#).expect("de");
        assert!(!none.request_caused_show);
    }

    /// `HideResponse` decodes both arms of the native-side
    /// `{ "requestCausedHide": … }` payload — `true` when a visible native
    /// webview was hidden, `false` when none was visible (idempotent hide). The
    /// `requestCausedHide` wire key must match the Swift/Kotlin emit.
    #[test]
    fn hide_response_decodes_request_caused_hide_flag() {
        let live: HideResponse = serde_json::from_str(r#"{"requestCausedHide":true}"#).expect("de");
        assert!(live.request_caused_hide);
        let already: HideResponse =
            serde_json::from_str(r#"{"requestCausedHide":false}"#).expect("de");
        assert!(!already.request_caused_hide);
    }

    /// `DisposeResponse` decodes both arms of the native-side
    /// `{ "requestCausedDispose": … }` payload — `true` when a live native
    /// webview was torn down, `false` when none existed (idempotent dispose).
    /// The `requestCausedDispose` wire key must match the Swift/Kotlin emit.
    #[test]
    fn dispose_response_decodes_request_caused_dispose_flag() {
        let live: DisposeResponse =
            serde_json::from_str(r#"{"requestCausedDispose":true}"#).expect("de");
        assert!(live.request_caused_dispose);
        let already: DisposeResponse =
            serde_json::from_str(r#"{"requestCausedDispose":false}"#).expect("de");
        assert!(!already.request_caused_dispose);
    }
}
