//! The background server service's host-side logic: running the Wildflower
//! server on its own runtime behind the run gate, the bridge wire mirror, and
//! the notification decisions. See the
//! [Design Explanation](../../docs/Design%20Explanation.md).
//!
//! Deliberately no `tauri` dependency, so everything that can be wrong is
//! testable without a webview toolkit; the `BackgroundService` impl and the
//! Tauri glue live in `background-server-service-tauri-rust`.

pub mod bridge;
pub mod foreground_resume;
pub mod notification;
pub mod plugin_event;
pub mod request_notifications;
pub mod run_gate;
pub mod server_run;
pub mod stop_notification;
pub mod tunnel_notification;

pub use bridge::{
    BackgroundServerServiceHostToWeb, BackgroundServerServiceWebToHost, NotificationPermission,
    ServerServiceState, ServerServiceStatus, RESTART_SERVER, SERVER_SERVICE_STATUS, TAGS,
};
pub use foreground_resume::{ForegroundResume, ResumeAction};
pub use notification::LocalNotification;
pub use plugin_event::{BackgroundServiceEvent, ServiceStopReason, BACKGROUND_SERVICE_EVENT};
pub use request_notifications::{CallerActivity, RequestNotificationCoalescer};
pub use run_gate::RunGate;
pub use server_run::{ServerHostContext, ServerRunState, ServerServiceReceivers};
pub use stop_notification::{failure_notification, stop_notification, RESTART_STOP_REASON};
pub use tunnel_notification::TunnelDropDetector;
