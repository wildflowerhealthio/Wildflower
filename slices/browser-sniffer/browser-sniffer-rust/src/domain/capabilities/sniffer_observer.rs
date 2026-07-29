//! The [`SnifferObserver`] capability — the `wildflower/Sniffer.r` door to the
//! `/sniffer/events` stream. Holds its `*_scopes()` mapping (read by both its
//! binding and [`grantable_sniffer_scopes`](super::grantable_sniffer_scopes)
//! so enforced and grantable can't drift).

use scopes_rust::{Permission, Scope, WildflowerResource};
use tokio::sync::broadcast;

use crate::domain::SnifferEvents;

/// The scope gating [`SnifferObserver`] — `wildflower/Sniffer.r`. The stream
/// carries the sniffed pages' response bodies verbatim, so reading it is as
/// sensitive as holding the account credentials that produced them.
pub(crate) fn sniffer_observer_scopes() -> Vec<Scope> {
    vec![Scope::wildflower(
        WildflowerResource::Sniffer,
        Permission::READ,
    )]
}

/// Subscribe to the sniffer's captured-activity stream — `GET /sniffer/events`
/// (WebSocket), gated by `wildflower/Sniffer.r`. Holds the events handle
/// lifted from the state.
pub(crate) struct SnifferObserver {
    events: SnifferEvents,
}

impl SnifferObserver {
    /// Build the observer over the events handle lifted from the state.
    pub(crate) fn new(events: SnifferEvents) -> Self {
        SnifferObserver { events }
    }

    /// A new subscription starting from the events published after this call.
    pub(crate) fn subscribe(&self) -> broadcast::Receiver<String> {
        self.events.subscribe()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The observer's subscription sees what the publisher publishes — the
    /// capability is a scope-gated door onto the same channel.
    #[tokio::test]
    async fn observer_subscribes_to_the_shared_stream() {
        let events = SnifferEvents::new();
        let observer = SnifferObserver::new(events.clone());
        let mut rx = observer.subscribe();
        events.publish(r#"{"_tag":"PageLoaded","url":"https://x","pageContentId":"p1"}"#.into());
        assert_eq!(
            rx.recv().await.unwrap(),
            r#"{"_tag":"PageLoaded","url":"https://x","pageContentId":"p1"}"#,
        );
    }
}
