//! Posting what [`servers_rust`] decides to notify about the servers: each
//! caller's requests through the tunnels, and each new stop of a server's
//! run, read from `TauriUnitRunner`'s statuses.

use std::time::Instant;

use servers_rust::{
    LocalNotification, RequestNotificationCoalescer, ServerDetail, StopNotificationTracker,
};
use shared_structures_rust::request_caller::ForwardedRequest;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_log::log;
use tauri_plugin_notification::Notification;
use tauri_unit_runner::UnitStatuses;
use tokio::sync::{mpsc, watch};

/// Post the per-caller request notifications the coalescer decides on, waking
/// for each owed update when it comes due.
pub(crate) async fn post_request_notifications<R: Runtime>(
    app: AppHandle<R>,
    mut forwarded_requests: mpsc::Receiver<ForwardedRequest>,
) {
    let mut coalescer = RequestNotificationCoalescer::new();
    loop {
        let next_update_due_at = coalescer.next_update_due_at();
        tokio::select! {
            forwarded_request = forwarded_requests.recv() => {
                let Some(forwarded_request) = forwarded_request else {
                    log::error!("[servers] forwarded-request channel closed; request notifications stopped");
                    return;
                };
                if let Some(activity) = coalescer.record(forwarded_request, Instant::now()) {
                    post_notification(&app, &activity.notification());
                }
            }
            () = sleep_until_due(next_update_due_at) => {
                for activity in coalescer.take_due_updates(Instant::now()) {
                    post_notification(&app, &activity.notification());
                }
            }
        }
    }
}

/// Sleep until `due_at`, or forever when nothing is due.
async fn sleep_until_due(due_at: Option<Instant>) {
    match due_at {
        Some(due_at) => tokio::time::sleep_until(due_at.into()).await,
        None => std::future::pending().await,
    }
}

/// Post a stop notification for each new stop of a server's run, as
/// [`StopNotificationTracker`] decides, every time `TauriUnitRunner`'s
/// statuses change.
pub(crate) async fn post_stop_notifications<R: Runtime>(
    app: AppHandle<R>,
    mut statuses: watch::Receiver<UnitStatuses<ServerDetail>>,
) {
    let mut tracker = StopNotificationTracker::new();
    loop {
        let current = statuses.borrow_and_update().clone();
        for notification in tracker.new_stop_notifications(&current) {
            post_notification(&app, &notification);
        }
        if statuses.changed().await.is_err() {
            log::error!("[servers] the unit runner's statuses closed; stop notifications stopped");
            return;
        }
    }
}

/// Post `notification`. A failure is logged: the notification is the end of
/// the line, with nothing further to report it to.
fn post_notification<R: Runtime>(app: &AppHandle<R>, notification: &LocalNotification) {
    let Some(notifications) = app.try_state::<Notification<R>>() else {
        log::warn!(
            "[servers] the notification plugin is not registered; {} not posted",
            notification.id
        );
        return;
    };
    if let Err(error) = notifications
        .builder()
        .id(notification.numeric_id())
        .title(&notification.title)
        .body(&notification.body)
        .show()
    {
        log::warn!("[servers] notification {} failed: {error}", notification.id);
    }
}
