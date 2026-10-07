//! Asking for permission to post notifications before `TauriUnitRunner` first
//! starts a background session.

use tauri::plugin::PermissionState;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_notification::Notification;

/// Ask the OS for permission to post notifications when it has never asked
/// (iOS, and Android 13 and later), and log the answer when it isn't a grant.
/// Units never depend on the answer.
///
/// Asked before `TauriUnitRunner`'s first start of the background service: the
/// plugin's start asks too, and on Android a second ask while the first is on
/// screen is cancelled, which reads as a refusal. A grant answered here leaves
/// the plugin nothing to ask.
///
/// Only a `Prompt` state is asked about. An unreadable state isn't: on Android
/// the notification plugin never answers a request for a permission already
/// granted, and the start waits on this. Desktop always reads as granted. The
/// plugin's mobile calls block until the native side answers, and the request
/// until the person does, so both run on a blocking thread.
pub(crate) async fn ask_for_notification_permission<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    let asked = tauri::async_runtime::spawn_blocking(move || {
        let Some(notifications) = handle.try_state::<Notification<R>>() else {
            return Err("the notification plugin is not registered".to_owned());
        };
        let permission_before_asking = notifications
            .permission_state()
            .map_err(|error| format!("the permission is unreadable: {error}"))?;
        match permission_before_asking {
            PermissionState::Prompt | PermissionState::PromptWithRationale => notifications
                .request_permission()
                .map(Some)
                .map_err(|error| format!("the request failed: {error}")),
            PermissionState::Granted | PermissionState::Denied => Ok(None),
        }
    })
    .await;
    match asked {
        Ok(Ok(Some(PermissionState::Granted))) => {
            log::info!("[unit-runner] notifications allowed");
        }
        Ok(Ok(Some(
            answer @ (PermissionState::Denied
            | PermissionState::Prompt
            | PermissionState::PromptWithRationale),
        ))) => log::warn!("[unit-runner] notifications not allowed ({answer})"),
        // Already answered, on an earlier launch or in the OS settings.
        Ok(Ok(None)) => {}
        Ok(Err(error)) => {
            log::warn!("[unit-runner] notification permission not asked for: {error}");
        }
        Err(error) => {
            log::error!("[unit-runner] the notification permission task failed: {error}");
        }
    }
}
