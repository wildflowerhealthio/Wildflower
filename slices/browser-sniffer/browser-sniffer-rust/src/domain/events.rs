//! The sniffer's host→client event stream — the channel seam between the host
//! adapter (which validates and publishes sniffed-page and lifecycle events)
//! and the `/sniffer/events` WebSocket fan-out.
//!
//! Every event is one pre-serialized tagged-JSON object (`{"_tag": …, …}`),
//! exactly the wire shapes `browser-sniffer-core`'s `messages.ts` declares —
//! the WebSocket forwards the strings verbatim, so cross-tag FIFO ordering (a
//! hard requirement: `ResponseData` chunks interleave with `ResponseStart` /
//! `ResponseFinished` and the collector's tracker depends on their order) is
//! whatever order the publisher `publish`es in. One channel, all tags — the
//! HTTP restatement of the bridge's single-`BRIDGE_EVENT` rule.

use tokio::sync::broadcast;

/// Host→client data-plane tag literals — the sniffed page's observation stream
/// (mirrors `browser-sniffer-core`'s `messages.ts` page→host set plus the `Log`
/// console-shim tag). The host adapter allowlists untrusted page messages to
/// exactly this set before publishing; see `browser-sniffer-tauri-rust`'s
/// `native_webview_bridge`.
pub const PAGE_LOADED: &str = "PageLoaded";
pub const RESPONSE_START: &str = "ResponseStart";
pub const RESPONSE_DATA: &str = "ResponseData";
pub const RESPONSE_FINISHED: &str = "ResponseFinished";
pub const REQUEST_ERROR: &str = "RequestError";
pub const CANCELLED: &str = "Cancelled";
pub const LOG: &str = "Log";

/// Host-synthesized lifecycle tag: the user dismissed (hid) the sniffer
/// webview. Host-originated — deliberately NOT in the page data-plane
/// allowlist, so a sniffed page can't cut an `AwaitUserDismiss` hold short.
pub const USER_DISMISSED: &str = "UserDismissed";

/// Host-synthesized lifecycle tag: the sniffer webview was torn down. Kept
/// distinct from [`USER_DISMISSED`]: a dispose is the normal outcome of the
/// client-driven teardown (`DELETE /sniffer/webview`), so one arrives on every
/// run and folding it into the dismissal signal would race ordinary shutdown.
pub const SNIFFER_DISPOSED: &str = "SnifferDisposed";

/// How many events the broadcast channel buffers per subscriber before a slow
/// reader is declared lagged. `ResponseData` chunks are the volume driver; the
/// WebSocket fan-out treats a lag as fatal for that connection (an honest
/// close beats silently dropping mid-stream chunks the collector's tracker
/// would mis-assemble).
pub const EVENT_CHANNEL_CAPACITY: usize = 16 * 1024;

/// The publisher half of the sniffer event stream. The host adapter holds one
/// and `publish`es every validated page event and synthesized lifecycle event;
/// the WebSocket route `subscribe`s per connection.
///
/// Cheap to clone (the channel is internally reference-counted). Publishing
/// with no live subscriber is a silent no-op — matching the bridge, where
/// emits before the SPA listener attached were dropped by the platform.
#[derive(Clone)]
pub struct SnifferEvents {
    sender: broadcast::Sender<String>,
}

impl SnifferEvents {
    /// A fresh event stream with the default buffer.
    #[must_use]
    pub fn new() -> Self {
        SnifferEvents {
            sender: broadcast::channel(EVENT_CHANNEL_CAPACITY).0,
        }
    }

    /// Publish one pre-serialized tagged-JSON event to every live subscriber.
    /// No subscriber is not an error.
    pub fn publish(&self, event_json: String) {
        // `send` errs only when there are no receivers; the stream is
        // best-effort by design (see the struct docs).
        let _ = self.sender.send(event_json);
    }

    /// Publish a host-synthesized, payload-less lifecycle event (`{"_tag": tag}`).
    pub fn publish_lifecycle(&self, tag: &str) {
        self.publish(format!(r#"{{"_tag":"{tag}"}}"#));
    }

    /// A new subscription starting from the events published after this call.
    #[must_use]
    pub fn subscribe(&self) -> broadcast::Receiver<String> {
        self.sender.subscribe()
    }
}

impl Default for SnifferEvents {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Publishing with no subscriber is a silent no-op, and a subscriber sees
    /// events in publish order — the FIFO guarantee the collector's tracker
    /// depends on.
    #[tokio::test]
    async fn events_fan_out_in_publish_order() {
        let events = SnifferEvents::new();
        events.publish(r#"{"_tag":"ResponseStart","id":"r0"}"#.to_owned());

        let mut rx = events.subscribe();
        events.publish(r#"{"_tag":"ResponseStart","id":"r1"}"#.to_owned());
        events.publish(r#"{"_tag":"ResponseData","id":"r1","data":"AA=="}"#.to_owned());
        events.publish(r#"{"_tag":"ResponseFinished","id":"r1"}"#.to_owned());

        assert_eq!(
            rx.recv().await.unwrap(),
            r#"{"_tag":"ResponseStart","id":"r1"}"#
        );
        assert_eq!(
            rx.recv().await.unwrap(),
            r#"{"_tag":"ResponseData","id":"r1","data":"AA=="}"#
        );
        assert_eq!(
            rx.recv().await.unwrap(),
            r#"{"_tag":"ResponseFinished","id":"r1"}"#
        );
    }

    /// The synthesized lifecycle events carry exactly the tag object the TS
    /// side decodes (`UserDismissed` / `SnifferDisposed` are payload-less
    /// tagged structs).
    #[tokio::test]
    async fn lifecycle_events_are_bare_tag_objects() {
        let events = SnifferEvents::new();
        let mut rx = events.subscribe();
        events.publish_lifecycle(USER_DISMISSED);
        events.publish_lifecycle(SNIFFER_DISPOSED);
        assert_eq!(rx.recv().await.unwrap(), r#"{"_tag":"UserDismissed"}"#);
        assert_eq!(rx.recv().await.unwrap(), r#"{"_tag":"SnifferDisposed"}"#);
    }

    /// Drift guard for the tag literals against the TS convention
    /// (`browser-sniffer-core`'s `messages.ts` + `collector-fundamentals`'s
    /// `bridge.ts`) — the WebSocket wire contract is these strings.
    #[test]
    fn event_tags_match_the_ts_convention() {
        assert_eq!(PAGE_LOADED, "PageLoaded");
        assert_eq!(RESPONSE_START, "ResponseStart");
        assert_eq!(RESPONSE_DATA, "ResponseData");
        assert_eq!(RESPONSE_FINISHED, "ResponseFinished");
        assert_eq!(REQUEST_ERROR, "RequestError");
        assert_eq!(CANCELLED, "Cancelled");
        assert_eq!(LOG, "Log");
        assert_eq!(USER_DISMISSED, "UserDismissed");
        assert_eq!(SNIFFER_DISPOSED, "SnifferDisposed");
    }
}
