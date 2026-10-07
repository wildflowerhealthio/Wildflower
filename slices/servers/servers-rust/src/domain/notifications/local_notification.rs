//! [`LocalNotification`], one notification the host posts about its servers.

/// One local notification, replaced in place by a later one with the same
/// [`id`](Self::id) where the platform supports it (Android and iOS; desktop
/// notifications stack). The host turns the id into the notification
/// plugin's numeric id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalNotification {
    /// The stable string id: `server-stopped:<domain>` or
    /// `server-requests:<caller>`.
    pub id: String,
    /// The notification's title.
    pub title: String,
    /// The notification's text.
    pub body: String,
}
