//! Wire shapes shared between the Rust command layer and the native (Swift /
//! Kotlin) plugin. `OpenRequest` is what crosses
//! `run_mobile_plugin_async("open", …)`, and `CloseRequest` what crosses
//! `run_mobile_plugin_async("close", …)`.
//! Field names are `camelCase` on the wire to match the Swift `Decodable` /
//! Kotlin `@InvokeArg` sides.
//!
//! A view's events flow the other direction (native → Rust) through the Tauri
//! [`Channel`] embedded in `OpenRequest` — see [`BrowserEvent`].

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

/// Arguments for opening the in-app browser.
///
/// `Serialize`-only because [`Channel`] only serialises one way — its on-wire
/// form is an opaque `"__CHANNEL__:<id>"` string the mobile-side
/// `Channel: Decodable` / Kotlin `Channel` deserializer parses to wire up the
/// send-back path.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRequest {
    /// The external URL to open. Only `http(s)://` is accepted.
    pub url: String,
    /// The caller's name for the view, unique among the views it opens:
    /// [`CloseRequest::view`] names the view to close by it.
    pub view: String,
    /// How the view shows beside the views already showing.
    pub mode: OpenMode,
    /// Hears this view's events: exactly one [`BrowserEvent::Closed`] on iOS
    /// and Android once `open` returns `Ok`, after at most one
    /// [`BrowserEvent::KeptAlive`] on Android, and on Android a
    /// [`BrowserEvent::MovedToBackground`] and
    /// [`BrowserEvent::ReturnedToForeground`] for each time the app leaves
    /// and comes back with the view over it; nothing on desktop or after an
    /// `Err`. On iOS a newer [`OpenMode::Replace`] `open`, or a `close` of
    /// this view or one under it, sends this view's `Closed`; on Android a
    /// [`OpenMode::Replace`] `open` that joins a view still launching (one a
    /// `Replace` open launched) hears that view's events.
    pub events: Channel<BrowserEvent>,
}

/// How an `open` shows its view beside the views already showing. Desktop
/// opens a browser tab either way.
///
/// On the wire, `"replace"` or `"stack"`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum OpenMode {
    /// One view at a time. On iOS the open closes the views showing, each
    /// reporting its `Closed`, before it presents its own. On Android it
    /// joins a view still launching that a `Replace` open launched instead of
    /// launching another.
    Replace,
    /// Over the views showing, which stay under it. On iOS the view is
    /// presented over the top-most one; on Android it launches its own
    /// Custom Tab even while another is launching.
    Stack,
}

/// Arguments for closing one view the plugin opened.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseRequest {
    /// The [`OpenRequest::view`] the view was opened under.
    pub view: String,
}

/// An event from an open in-app browser view, sent on its
/// [`OpenRequest::events`] channel.
///
/// Internally tagged on `event` (`{"event":"closed"}`, `{"event":"keptAlive"}`,
/// `{"event":"movedToBackground"}`, `{"event":"returnedToForeground"}`)
/// — the tags are pinned so the Swift/Kotlin `channel.send([...])` callsites
/// can hand-roll the dictionary. Drift between this tag and what the native sides emit would
/// fail the Rust handler's deserialise (the tests below guard the wire shape).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "event")]
pub enum BrowserEvent {
    /// Android: the view's browser keeps the app alive while the view is open,
    /// by binding a service of the app's, so Android doesn't cut the app's
    /// network under the view. Sent at most once per open, before its
    /// `Closed`, and only by a browser that honours the Custom Tabs keep-alive
    /// extra (Chrome does).
    #[serde(rename = "keptAlive")]
    KeptAlive,
    /// The view is gone: the user closed it (close button, edge swipe, system
    /// back), or, on iOS, a newer `open` replaced it or a `close` closed it or
    /// a view under it. Sent once per open, on iOS
    /// and Android only — on desktop the page opens in a browser tab, which isn't a
    /// window the app owns.
    #[serde(rename = "closed")]
    Closed,
    /// Android: the app went fully to the background with the view over it,
    /// the user leaving for the home screen or another app, as the view's
    /// browser letting go of the app says. Sent to every open view, once per
    /// departure, and only by a browser that kept the app alive
    /// ([`KeptAlive`](Self::KeptAlive)). Closing the view back onto the app
    /// sends none.
    #[serde(rename = "movedToBackground")]
    MovedToBackground,
    /// Android: the app came back from fully in the background with the
    /// view still over it, as from the app switcher. Sent to every open view,
    /// once per return after a [`MovedToBackground`](Self::MovedToBackground).
    #[serde(rename = "returnedToForeground")]
    ReturnedToForeground,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `OpenRequest` rides the wire as
    /// `{ "url": …, "view": …, "mode": …, "events": "__CHANNEL__:…" }` — the
    /// keys the Swift `OpenArgs` / Kotlin `OpenArgs` decode. Drift here would
    /// silently break decoding on-device.
    #[test]
    fn open_request_serializes_url_view_mode_and_events_channel() {
        let json = serde_json::to_value(OpenRequest {
            url: "https://example.test/launcher/".to_owned(),
            view: "launch-1".to_owned(),
            mode: OpenMode::Stack,
            events: Channel::new(|_| Ok(())),
        })
        .expect("serialize");
        let object = json.as_object().expect("object");
        // Sorted, because key order depends on whether serde_json's
        // `preserve_order` feature is unified into the build.
        let mut keys = object.keys().map(String::as_str).collect::<Vec<_>>();
        keys.sort_unstable();
        assert_eq!(keys, ["events", "mode", "url", "view"]);
        assert_eq!(
            object.get("url").and_then(|v| v.as_str()),
            Some("https://example.test/launcher/")
        );
        assert_eq!(
            object.get("view").and_then(|v| v.as_str()),
            Some("launch-1")
        );
        assert_eq!(object.get("mode").and_then(|v| v.as_str()), Some("stack"));
        // Channel serialises as an opaque IPC handle string; only the prefix is
        // checked to stay version-agnostic.
        assert!(object
            .get("events")
            .and_then(|v| v.as_str())
            .is_some_and(|s| s.starts_with("__CHANNEL__:")));
    }

    /// `BrowserEvent::Closed` is `{ "event":"closed" }` both ways — what the
    /// Swift/Kotlin `channel.send([…])` calls emit.
    #[test]
    fn browser_event_closed_round_trips_with_lowercase_tag() {
        let json = r#"{"event":"closed"}"#;
        let event: BrowserEvent = serde_json::from_str(json).expect("de");
        assert_eq!(event, BrowserEvent::Closed);
        assert_eq!(serde_json::to_string(&event).expect("ser"), json);
    }

    /// `BrowserEvent::KeptAlive` is `{ "event":"keptAlive" }` both ways — what
    /// the Kotlin `channel.send(…)` call emits.
    #[test]
    fn browser_event_kept_alive_round_trips_with_camel_case_tag() {
        let json = r#"{"event":"keptAlive"}"#;
        let event: BrowserEvent = serde_json::from_str(json).expect("de");
        assert_eq!(event, BrowserEvent::KeptAlive);
        assert_eq!(serde_json::to_string(&event).expect("ser"), json);
    }

    /// The app's departure and return under a view are
    /// `{ "event":"movedToBackground" }` and
    /// `{ "event":"returnedToForeground" }` both ways — what the Kotlin
    /// `channel.send(…)` calls emit.
    #[test]
    fn browser_events_for_the_app_leaving_and_returning_round_trip_with_camel_case_tags() {
        for (json, expected) in [
            (
                r#"{"event":"movedToBackground"}"#,
                BrowserEvent::MovedToBackground,
            ),
            (
                r#"{"event":"returnedToForeground"}"#,
                BrowserEvent::ReturnedToForeground,
            ),
        ] {
            let event: BrowserEvent = serde_json::from_str(json).expect("de");
            assert_eq!(event, expected);
            assert_eq!(serde_json::to_string(&event).expect("ser"), json);
        }
    }

    /// `OpenMode` is `"replace"` or `"stack"`, the raw values the Swift
    /// `OpenMode` and the Kotlin `OpenArgs.mode` match.
    #[test]
    fn open_mode_is_its_lowercase_name() {
        assert_eq!(
            serde_json::to_value([OpenMode::Replace, OpenMode::Stack]).expect("serialize"),
            serde_json::json!(["replace", "stack"])
        );
    }

    /// `CloseRequest` rides the wire as `{ "view": … }`, the key the Swift
    /// `CloseArgs` decodes.
    #[test]
    fn close_request_serializes_its_view() {
        assert_eq!(
            serde_json::to_value(CloseRequest {
                view: "launch-1".to_owned()
            })
            .expect("serialize"),
            serde_json::json!({ "view": "launch-1" })
        );
    }
}
