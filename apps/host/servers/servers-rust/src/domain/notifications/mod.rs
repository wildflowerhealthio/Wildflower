//! What the host notifies about its servers, decided free of I/O: the
//! [`LocalNotification`] it posts, the notification for each stop of a
//! server's run `UnitRunner` reports, and the one for each new consent waiting
//! on a server. The host posts them.

pub mod consent_notifications;
pub mod fnv1a;
pub mod local_notification;
pub mod stop_notifications;
