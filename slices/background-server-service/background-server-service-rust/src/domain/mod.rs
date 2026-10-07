//! The service's own rules, free of I/O: the run gate that admits one server
//! run at a time, the state each run reports, what a foreground resume does,
//! and the local notification for a stop or a caller's requests. Nothing here
//! imports [`crate::live_bindings`].

pub mod foreground_resume;
pub mod notification;
pub mod request_notifications;
pub mod run_gate;
pub mod server_run_state;
pub mod stop_notification;
