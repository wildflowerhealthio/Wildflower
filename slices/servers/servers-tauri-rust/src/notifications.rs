//! Posting what [`servers_rust`] decides to notify about the servers: each
//! caller's requests through the tunnels, and each stop of a server's run
//! `TauriUnitRunner` reports.

use std::time::Instant;

use servers_rust::{LocalNotification, RequestNotificationCoalescer, StopNotificationCoalescer};
use shared_structures_rust::request_caller::ForwardedRequest;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_log::log;
use tauri_plugin_notification::Notification;
use tauri_unit_runner::RunStopped;
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::{broadcast, mpsc};

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
                if let Some(server_stopped) = coalescer.record(&stopped) {
                    post_notification(&app, &server_stopped.notification());
                }
            }
            Err(RecvError::Lagged(missed)) => {
                log::warn!("[servers] fell behind the unit runner's stops; {missed} not notified");
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
        .id(plugin_notification_id(&notification.id))
        .title(&notification.title)
        .body(&notification.body)
        .show()
    {
        log::warn!("[servers] notification {} failed: {error}", notification.id);
    }
}

/// `id`, a [`LocalNotification`]'s string id, as the positive, non-zero `i32`
/// the notification plugin takes, the same on every call and across launches
/// (32-bit FNV-1a with the sign bit cleared and the low bit set).
///
/// # Remarks
///
/// Android treats a non-positive id as "no id", so the sign bit is masked off
/// rather than the hash reinterpreted as signed. Two string ids can collide;
/// with the handful of ids the host posts, that is accepted.
fn plugin_notification_id(id: &str) -> i32 {
    let hash = id.bytes().fold(0x811c_9dc5_u32, |hash, byte| {
        (hash ^ u32::from(byte)).wrapping_mul(0x0100_0193)
    });
    let positive = i32::from_be_bytes((hash & 0x7fff_ffff).to_be_bytes());
    positive | 1
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    /// Pinned values: a change to the hash would orphan the notifications
    /// already on a device under their old ids.
    #[test]
    fn plugin_notification_ids_are_pinned() {
        // FNV-1a("server-stopped:ruth.relay.example.com") = 0xdf692c69 → masked 0x5f692c69 → | 1.
        assert_eq!(
            plugin_notification_id("server-stopped:ruth.relay.example.com"),
            0x5f69_2c69
        );
        // FNV-1a("server-requests:client:lifting") = 0x8dd190a5 → masked 0x0dd190a5 → | 1.
        assert_eq!(
            plugin_notification_id("server-requests:client:lifting"),
            0x0dd1_90a5
        );
    }

    proptest! {
        #[test]
        fn plugin_notification_ids_are_positive_and_stable(id in ".{0,64}") {
            prop_assert!(plugin_notification_id(&id) > 0);
            prop_assert_eq!(plugin_notification_id(&id), plugin_notification_id(&id.clone()));
        }
    }
}
