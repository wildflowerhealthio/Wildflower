//! Posting what [`wildflowerhealthio_servers`] decides to notify about the
//! servers: each stop of a server's run `TauriUnitRunner` reports;
//! [`post_notification`] posts the consent requests too, with their actions,
//! and the ongoing consent notification on Android;
//! [`withdraw_consent_notification`] withdraws a server's, and
//! [`withdraw_ongoing_consent_notification`] the ongoing one. On a phone,
//! [`register_consent_notification_actions`] registers the actions first.

use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_log::log;
use tauri_plugin_notification::Notification;
use tokio::sync::broadcast;
use tokio::sync::broadcast::error::RecvError;
use wildflowerhealthio_servers::{LocalNotification, StopNotificationCoalescer};
use wildflowerhealthio_tauri_unit_runner::RunStopped;

/// Post a stop notification for each stop of a server's run
/// `TauriUnitRunner` reports, as [`StopNotificationCoalescer`] decides.
pub(crate) async fn post_stop_notifications<R: Runtime>(
    app: AppHandle<R>,
    mut stops: broadcast::Receiver<RunStopped>,
) {
    let mut coalescer = StopNotificationCoalescer::new();
    loop {
        match stops.recv().await {
            Ok(stopped) => {
                if let Some(server_stop) = coalescer.record(stopped) {
                    post_notification(
                        &app,
                        &server_stop.notification(),
                        NotificationKind::ServerStop,
                    );
                }
            }
            Err(RecvError::Lagged(missed)) => {
                log::warn!("[servers] fell behind the unit runner's stops; {missed} not notified");
                // The missed stops may have cleared a remembered failure, so
                // forget them all: a repeat notifies once more rather than
                // never.
                coalescer = StopNotificationCoalescer::new();
            }
            Err(RecvError::Closed) => {
                log::error!("[servers] the unit runner's stops closed; stop notifications stopped");
                return;
            }
        }
    }
}

/// What a notification the host posts is for, which says how it is posted
/// beyond its text: on a phone, the actions it offers; on Android, whether it
/// stays and how loudly.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NotificationKind {
    /// A stop of a server's run: its text only.
    ServerStop,
    /// A consent request waiting on a server: on a phone, Deny besides the
    /// tap that opens it.
    ConsentRequest,
    /// The ongoing consent notification, posted on Android only: Open and
    /// Deny, kept until it is withdrawn, on a channel that makes no sound.
    OngoingConsent,
}

/// The action type of a consent request's notification: Deny.
#[cfg(any(target_os = "ios", target_os = "android"))]
const CONSENT_REQUEST_ACTION_TYPE_ID: &str = "consent-request";

/// The action type of the ongoing consent notification: Open and Deny.
#[cfg(any(target_os = "ios", target_os = "android"))]
const ONGOING_CONSENT_ACTION_TYPE_ID: &str = "ongoing-consent";

/// The channel the ongoing consent notification posts on: low importance, so
/// it shows in the shade without a sound or a heads-up, each request's own
/// notification having alerted already.
#[cfg(target_os = "android")]
const ONGOING_CONSENT_CHANNEL_ID: &str = "ongoing-consent";

/// Register the actions the consent notifications offer, on a phone, before
/// any posts: Deny on a request's notification, and Open and Deny on the
/// ongoing one; and, on Android, the ongoing one's quiet channel. Open brings
/// the app to the foreground, to show the request; Deny doesn't need to. A
/// failure is logged, and the notifications post without the actions.
#[cfg(any(target_os = "ios", target_os = "android"))]
pub(crate) fn register_consent_notification_actions<R: Runtime>(app: &AppHandle<R>) {
    use tauri_plugin_notification::{Action, ActionType};
    use wildflowerhealthio_servers::{DENY_CONSENT_ACTION_ID, OPEN_CONSENT_ACTION_ID};

    let Some(notifications) = app.try_state::<Notification<R>>() else {
        log::warn!(
            "[servers] the notification plugin is not registered; the consent notifications' \
             actions aren't"
        );
        return;
    };
    let open = || {
        Action::builder(OPEN_CONSENT_ACTION_ID, "Open")
            .foreground(true)
            .build()
    };
    let deny = || {
        Action::builder(DENY_CONSENT_ACTION_ID, "Deny")
            .destructive(true)
            .build()
    };
    if let Err(error) = notifications.register_action_types(vec![
        ActionType::builder(CONSENT_REQUEST_ACTION_TYPE_ID)
            .actions(vec![deny()])
            .build(),
        ActionType::builder(ONGOING_CONSENT_ACTION_TYPE_ID)
            .actions(vec![open(), deny()])
            .build(),
    ]) {
        log::warn!("[servers] registering the consent notifications' actions failed: {error}");
    }
    #[cfg(target_os = "android")]
    if let Err(error) = notifications.create_channel(
        tauri_plugin_notification::Channel::builder(
            ONGOING_CONSENT_CHANNEL_ID,
            "Access requests waiting",
        )
        .description("Stays while an access request waits for your answer")
        .importance(tauri_plugin_notification::Importance::Low)
        .build(),
    ) {
        log::warn!("[servers] creating the ongoing consent notification's channel failed: {error}");
    }
}

/// Desktop builds register nothing: the plugin offers no actions there.
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub(crate) fn register_consent_notification_actions<R: Runtime>(_app: &AppHandle<R>) {}

/// Post `notification`, for what `kind` says it is. A failure is logged: the
/// notification is the end of the line, with nothing further to report it to.
pub(crate) fn post_notification<R: Runtime>(
    app: &AppHandle<R>,
    notification: &LocalNotification,
    kind: NotificationKind,
) {
    let Some(notifications) = app.try_state::<Notification<R>>() else {
        log::warn!(
            "[servers] the notification plugin is not registered; {} not posted",
            notification.id
        );
        return;
    };
    let builder = notifications
        .builder()
        .id(notification.hash_id_for_plugin())
        .title(&notification.title)
        .body(&notification.body);
    #[cfg(any(target_os = "ios", target_os = "android"))]
    let builder = match kind {
        NotificationKind::ServerStop => builder,
        NotificationKind::ConsentRequest => builder.action_type_id(CONSENT_REQUEST_ACTION_TYPE_ID),
        NotificationKind::OngoingConsent => builder.action_type_id(ONGOING_CONSENT_ACTION_TYPE_ID),
    };
    #[cfg(target_os = "android")]
    let builder = if kind == NotificationKind::OngoingConsent {
        builder.ongoing().channel_id(ONGOING_CONSENT_CHANNEL_ID)
    } else {
        builder
    };
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    let _ = kind;
    if let Err(error) = builder.show() {
        log::warn!("[servers] notification {} failed: {error}", notification.id);
    }
}

/// Withdraw the server `domain`'s consent notification from the
/// notifications shown, on a phone. A failure is logged, as for
/// [`post_notification`]. A desktop's plugin can't withdraw a notification,
/// and reports no taps on one, so there it stays until the user dismisses it.
#[cfg(any(target_os = "ios", target_os = "android"))]
pub(crate) fn withdraw_consent_notification<R: Runtime>(app: &AppHandle<R>, domain: &str) {
    withdraw_notification(
        app,
        wildflowerhealthio_servers::consent_notification_id_for_plugin(domain),
        &format!("{domain}'s consent notification"),
    );
}

/// Desktop builds withdraw nothing: see the mobile variant.
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub(crate) fn withdraw_consent_notification<R: Runtime>(_app: &AppHandle<R>, _domain: &str) {}

/// Withdraw the ongoing consent notification, on Android, the one platform
/// that posts it. A failure is logged, as for [`post_notification`].
#[cfg(target_os = "android")]
pub(crate) fn withdraw_ongoing_consent_notification<R: Runtime>(app: &AppHandle<R>) {
    withdraw_notification(
        app,
        wildflowerhealthio_servers::ongoing_consent_notification_id_for_plugin(),
        "the ongoing consent notification",
    );
}

/// Other builds post no ongoing consent notification to withdraw.
#[cfg(not(target_os = "android"))]
pub(crate) fn withdraw_ongoing_consent_notification<R: Runtime>(_app: &AppHandle<R>) {}

/// Withdraw the notification posted under `plugin_id`, `what` it is, from the
/// notifications shown. A failure is logged, as for [`post_notification`].
#[cfg(any(target_os = "ios", target_os = "android"))]
fn withdraw_notification<R: Runtime>(app: &AppHandle<R>, plugin_id: i32, what: &str) {
    let Some(notifications) = app.try_state::<Notification<R>>() else {
        log::warn!("[servers] the notification plugin is not registered; {what} not withdrawn");
        return;
    };
    if let Err(error) = notifications.remove_active(vec![plugin_id]) {
        log::warn!("[servers] withdrawing {what} failed: {error}");
    }
}
