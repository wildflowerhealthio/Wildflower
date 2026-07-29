//! `GET /sniffer/events` — the WebSocket that streams the sniffer's captured
//! activity (the page data plane: `ResponseStart` / `ResponseData` /
//! `ResponseFinished` / `RequestError` / `Cancelled` / `PageLoaded` / `Log`,
//! plus the host-synthesized `UserDismissed` / `SnifferDisposed` lifecycle
//! events) to the driving client. Replaces the bridge's host→web half.
//!
//! One socket carries **every** tag as text frames of tagged JSON, in publish
//! order — the FIFO-across-tags guarantee the collector's response tracker
//! depends on (per-tag streams would let a `ResponseFinished` overtake its
//! `ResponseData` chunks). Client→host control stays on the REST endpoints;
//! inbound frames are drained only so ping/pong keepalives are serviced.
//!
//! This route is registered on the plain axum `Router` (not the
//! `OpenApiRouter`): OpenAPI 3.1 has no WebSocket operation shape, so the
//! message contract is pinned by the TS schemas (`browser-sniffer-core`'s
//! `messages.ts`) and the Rust tag drift-guards instead of the snapshot.

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::response::Response;
use tokio::sync::broadcast;

use scope_capabilities_rust::Scoped;

use crate::domain::capabilities::SnifferObserver;

/// `GET /sniffer/events` — upgrade to the sniffer event stream. Gated by
/// `Scoped<SnifferObserver>` (`wildflower/Sniffer.r`); the scope check runs
/// before the upgrade, so an under-scoped caller gets the plain 403.
pub(crate) async fn handle_sniffer_events(
    observer: Scoped<SnifferObserver>,
    ws: WebSocketUpgrade,
) -> Response {
    let receiver = observer.subscribe();
    ws.on_upgrade(move |socket| pump(receiver, socket))
}

/// Forward events to the socket until the subscription or the socket ends.
/// Inbound frames are read concurrently (dropping their content) so the
/// transport's ping/pong keepalive is serviced; a client close ends the pump.
async fn pump(mut receiver: broadcast::Receiver<String>, mut socket: WebSocket) {
    loop {
        tokio::select! {
            event = receiver.recv() => {
                match next_frame(event) {
                    FrameDecision::Send(text) => {
                        if socket.send(Message::Text(text.into())).await.is_err() {
                            return; // client gone
                        }
                    }
                    FrameDecision::CloseLagged => {
                        // An honest close beats silently resuming mid-stream:
                        // dropped `ResponseData` chunks would corrupt every
                        // response the collector assembles after the gap.
                        let _ = socket
                            .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                                code: axum::extract::ws::close_code::ERROR,
                                reason: "event stream lagged; reconnect and restart the run".into(),
                            })))
                            .await;
                        return;
                    }
                    FrameDecision::End => return,
                }
            }
            inbound = socket.recv() => {
                match inbound {
                    // Frames are dropped (control rides REST); ping/pong is
                    // handled by the transport during this read.
                    Some(Ok(_)) => {}
                    Some(Err(_)) | None => return,
                }
            }
        }
    }
}

/// What to do with one subscription read — factored out so the lag/close
/// policy is unit-testable without a socket.
#[derive(Debug, PartialEq)]
enum FrameDecision {
    Send(String),
    CloseLagged,
    End,
}

fn next_frame(event: Result<String, broadcast::error::RecvError>) -> FrameDecision {
    match event {
        Ok(text) => FrameDecision::Send(text),
        Err(broadcast::error::RecvError::Lagged(_)) => FrameDecision::CloseLagged,
        Err(broadcast::error::RecvError::Closed) => FrameDecision::End,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A received event forwards; a lag is a fatal close (never a silent
    /// resume); a closed channel ends the stream cleanly.
    #[test]
    fn frame_decisions_cover_the_three_read_outcomes() {
        assert_eq!(
            next_frame(Ok(r#"{"_tag":"PageLoaded"}"#.to_owned())),
            FrameDecision::Send(r#"{"_tag":"PageLoaded"}"#.to_owned()),
        );
        assert_eq!(
            next_frame(Err(broadcast::error::RecvError::Lagged(7))),
            FrameDecision::CloseLagged,
        );
        assert_eq!(
            next_frame(Err(broadcast::error::RecvError::Closed)),
            FrameDecision::End,
        );
    }
}
