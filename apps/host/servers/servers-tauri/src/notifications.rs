//! Posting what [`wildflowerhealthio_servers`] decides to notify about the
//! servers: each stop of a server's run `TauriUnitRunner` reports;
//! [`post_notification`] posts the consent requests too, and
//! [`withdraw_consent_notification`] withdraws a server's.

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
                    post_notification(&app, &server_stop.notification());
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

/// Post `notification`. A failure is logged: the notification is the end of
/// the line, with nothing further to report it to.
pub(crate) fn post_notification<R: Runtime>(app: &AppHandle<R>, notification: &LocalNotification) {
    let Some(notifications) = app.try_state::<Notification<R>>() else {
        log::warn!(
            "[servers] the notification plugin is not registered; {} not posted",
            notification.id
        );
        return;
    };
    if let Err(error) = notifications
        .builder()
        .id(notification.hash_id_for_plugin())
        .title(&notification.title)
        .body(&notification.body)
        .show()
    {
        log::warn!("[servers] notification {} failed: {error}", notification.id);
    }
}

/// Withdraw the server `domain`'s consent notification from the
/// notifications shown, on a phone. A failure is logged, as for
/// [`post_notification`]. A desktop's plugin can't withdraw a notification,
/// and reports no taps on one, so there it stays until the user dismisses it.
#[cfg(any(target_os = "ios", target_os = "android"))]
pub(crate) fn withdraw_consent_notification<R: Runtime>(app: &AppHandle<R>, domain: &str) {
    let Some(notifications) = app.try_state::<Notification<R>>() else {
        log::warn!(
            "[servers] the notification plugin is not registered; \
             {domain}'s consent notification not withdrawn"
        );
        return;
    };
    if let Err(error) = notifications.remove_active(vec![
        wildflowerhealthio_servers::consent_notification_id_for_plugin(domain),
    ]) {
        log::warn!("[servers] withdrawing {domain}'s consent notification failed: {error}");
    }
}

/// Desktop builds withdraw nothing: see the mobile variant.
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub(crate) fn withdraw_consent_notification<R: Runtime>(_app: &AppHandle<R>, _domain: &str) {}
