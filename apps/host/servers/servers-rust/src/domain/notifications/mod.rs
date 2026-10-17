//! What the host notifies about its servers, decided free of I/O: the
//! [`LocalNotification`] it posts, the notification for each stop of a
//! server's run `UnitRunner` reports, and the one for each new consent waiting
//! on a server, with the actions they offer and the ongoing one that stays on
//! Android while a request is pending; and which consents show in a view of
//! the in-app browser, so each opens in one. The host posts and opens them.

pub mod announced_consents;
pub mod consent_notifications;
pub mod consent_views;
pub mod fnv1a;
pub mod local_notification;
pub mod stop_notifications;
