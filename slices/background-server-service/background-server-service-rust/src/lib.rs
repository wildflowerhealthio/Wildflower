//! The serde mirror of `BackgroundServerServiceBridge`, the server-status wire
//! between the host and the web app, pinned by golden tests to the wire
//! strings `wildflower-server-core-js`'s tests read too. See the slice's
//! [AGENTS.md](../../AGENTS.md).
//!
//! The wire is kept for the web app's server status over a future websocket;
//! nothing in the host sends or listens for it.

pub mod bridge;

pub use bridge::{
    BackgroundServerServiceHostToWeb, BackgroundServerServiceWebToHost, NotificationPermission,
    ServerServiceState, ServerServiceStatus, ServiceStopReason, RESTART_SERVER,
    SERVER_SERVICE_STATUS, TAGS,
};
