//! What the host notifies about its servers, decided free of I/O: the
//! [`LocalNotification`] it posts, the per-caller coalescing of the requests
//! the servers' tunnels relay, and the notification for each new stop of a
//! server's run, read from `UnitRunner`'s statuses. The host posts them.

pub mod local_notification;
pub mod request_notifications;
pub mod stop_notification;
