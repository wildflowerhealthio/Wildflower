//! The background server service's host-side logic: running the Wildflower
//! server on its own runtime behind the run gate, the bridge wire mirror, and
//! the notification decisions. See the
//! [Design Explanation](../../docs/Design%20Explanation.md).
//!
//! Deliberately no `tauri` dependency, so everything that can be wrong is
//! testable without a webview toolkit; the `BackgroundService` impl and the
//! Tauri glue live in `background-server-service-tauri-rust`.
//!
//! Layered like `tunnel-rust`:
//!
//!  - [`bridge`] and [`plugin_event`] — the serde wire mirrors of the bridge
//!    and of the plugin's lifecycle events, at the crate root like
//!    `gatekeeper-rust`'s `bridge`.
//!  - [`domain`] — the run gate, the run state, the foreground-resume rule and
//!    the notification decisions.
//!  - [`live_bindings`] — a server run: the domain bound to
//!    `wildflower-server-rust` on a dedicated thread and runtime.

pub mod bridge;
pub mod domain;
pub mod live_bindings;
pub mod plugin_event;

pub use bridge::{
    BackgroundServerServiceHostToWeb, BackgroundServerServiceWebToHost, NotificationPermission,
    ServerServiceState, ServerServiceStatus, RESTART_SERVER, SERVER_SERVICE_STATUS, TAGS,
};
pub use domain::foreground_resume::{ForegroundResume, ResumeAction};
pub use domain::notification::LocalNotification;
pub use domain::request_notifications::{CallerActivity, RequestNotificationCoalescer};
pub use domain::run_gate::RunGate;
pub use domain::stop_notification::{failure_notification, stop_notification, HOST_STOP_REASON};
pub use domain::tunnel_drop_detector::TunnelDropDetector;
pub use live_bindings::server_run::{
    run_published_server, ServerHost, ServerHostContext, ServerServiceReceivers, ServerToRun,
};
pub use plugin_event::{BackgroundServiceEvent, ServiceStopReason, BACKGROUND_SERVICE_EVENT};
pub use shared_structures_rust::server_run_state::ServerRunState;
