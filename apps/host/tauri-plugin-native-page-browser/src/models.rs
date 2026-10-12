//! Wire shapes shared between the Rust command layer and the native (Swift /
//! Kotlin) plugin. `OpenRequest` is what crosses `run_mobile_plugin("open", …)`.
//! Field names are `camelCase` on the wire to match the Swift `Decodable` /
//! Kotlin `@InvokeArg` sides.
//!
//! The close report flows the other direction (native → Rust) through the Tauri
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
    /// Hears this view close: exactly one [`BrowserEvent::Closed`] on iOS and
    /// Android, nothing on desktop.
    pub closed: Channel<BrowserEvent>,
}

/// An event from an open in-app browser view, sent on its
/// [`OpenRequest::closed`] channel.
///
/// Internally tagged on `event` (`{"event":"closed"}`) — the tag is pinned
/// lowercase so the Swift/Kotlin `channel.send([...])` callsites can hand-roll
/// the dictionary. Drift between this tag and what the native sides emit would
/// fail the Rust handler's deserialise (the tests below guard the wire shape).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "event")]
pub enum BrowserEvent {
    /// The view is gone: the user closed it (close button, edge swipe, system
    /// back), or a newer `open` replaced it. Sent once per open, on iOS and
    /// Android only — on desktop the page opens in a browser tab, which isn't a
    /// window the app owns.
    #[serde(rename = "closed")]
    Closed,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `OpenRequest` rides the wire as `{ "url": …, "closed": "__CHANNEL__:…" }`
    /// — the keys the Swift `OpenArgs` / Kotlin `OpenArgs` decode. Drift here
    /// would silently break decoding on-device.
    #[test]
    fn open_request_serializes_url_and_closed_channel() {
        let json = serde_json::to_value(OpenRequest {
            url: "https://example.test/launcher/".to_owned(),
            closed: Channel::new(|_| Ok(())),
        })
        .expect("serialize");
        let object = json.as_object().expect("object");
        assert_eq!(
            object.keys().map(String::as_str).collect::<Vec<_>>(),
            ["closed", "url"],
        );
        assert_eq!(
            object.get("url").and_then(|v| v.as_str()),
            Some("https://example.test/launcher/")
        );
        // Channel serialises as an opaque IPC handle string; only the prefix is
        // checked to stay version-agnostic.
        assert!(object
            .get("closed")
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
}
