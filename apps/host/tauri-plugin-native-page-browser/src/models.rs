//! Wire shapes shared between the Rust command layer and the native (Swift /
//! Kotlin) plugin. `OpenRequest` is what crosses
//! `run_mobile_plugin_async("open", …)`.
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
    /// Hears this view's events: exactly one [`BrowserEvent::Closed`] on iOS
    /// and Android once `open` returns `Ok`, after at most one
    /// [`BrowserEvent::KeptAlive`] on Android; nothing on desktop or after an
    /// `Err`. On iOS a newer `open` replaces a showing view, which sends this
    /// view's `Closed`; on Android that `open` joins a view still launching,
    /// and hears that view's events.
    pub events: Channel<BrowserEvent>,
}

/// An event from an open in-app browser view, sent on its
/// [`OpenRequest::events`] channel.
///
/// Internally tagged on `event` (`{"event":"closed"}`, `{"event":"keptAlive"}`)
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
    /// back), or, on iOS, a newer `open` replaced it. Sent once per open, on iOS
    /// and Android only — on desktop the page opens in a browser tab, which isn't a
    /// window the app owns.
    #[serde(rename = "closed")]
    Closed,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `OpenRequest` rides the wire as `{ "url": …, "events": "__CHANNEL__:…" }`
    /// — the keys the Swift `OpenArgs` / Kotlin `OpenArgs` decode. Drift here
    /// would silently break decoding on-device.
    #[test]
    fn open_request_serializes_url_and_events_channel() {
        let json = serde_json::to_value(OpenRequest {
            url: "https://example.test/launcher/".to_owned(),
            events: Channel::new(|_| Ok(())),
        })
        .expect("serialize");
        let object = json.as_object().expect("object");
        // Sorted, because key order depends on whether serde_json's
        // `preserve_order` feature is unified into the build.
        let mut keys = object.keys().map(String::as_str).collect::<Vec<_>>();
        keys.sort_unstable();
        assert_eq!(keys, ["events", "url"]);
        assert_eq!(
            object.get("url").and_then(|v| v.as_str()),
            Some("https://example.test/launcher/")
        );
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
}
