//! The [`PENDING_CONSENT_EVENT`]: the oldest consent waiting on each server,
//! sent to the base whenever it changes, and the desktop window brought
//! forward when a server gets one.

use servers_rust::{PendingConsent, PendingConsentTracker, ServerDetail};
use tauri::{AppHandle, Emitter, Runtime};
use tauri_plugin_log::log;
use tauri_unit_runner::UnitStatuses;
use tokio::sync::watch;

use crate::BASE_WEBVIEW_LABEL;

/// The Tauri event a server's [`PendingConsent`] is emitted on, one event
/// per server whose waiting consent changed, to the `main` webview, which runs
/// the base: `{domain, head?}`, `head` left out once nothing waits there,
/// including when the server stops or is removed.
pub const PENDING_CONSENT_EVENT: &str = "pending-consent";

/// Emit the [`PENDING_CONSENT_EVENT`] for each server whose waiting consent
/// changed, every time `TauriUnitRunner`'s statuses change, as
/// [`PendingConsentTracker`] picks them, and bring the window forward on the
/// desktop when a server that had nothing waiting gets a consent.
pub(crate) async fn emit_pending_consents<R: Runtime>(
    app: AppHandle<R>,
    mut statuses: watch::Receiver<UnitStatuses<ServerDetail>>,
) {
    let mut tracker = PendingConsentTracker::new();
    loop {
        let current = statuses.borrow_and_update().clone();
        let changes = tracker.changed_pending_consents(&current);
        for change in &changes {
            emit_pending_consent(&app, &change.pending_consent);
        }
        if changes.iter().any(|change| change.newly_waiting) {
            raise_main_window(&app);
        }
        if statuses.changed().await.is_err() {
            log::error!(
                "[servers] the unit runner's statuses closed; pending-consent events stopped"
            );
            return;
        }
    }
}

/// Emit `pending_consent` to the base. A failure is logged: the base reads
/// every waiting consent again from `pending_consents_list`.
fn emit_pending_consent<R: Runtime>(app: &AppHandle<R>, pending_consent: &PendingConsent) {
    if let Err(error) = app.emit_to(BASE_WEBVIEW_LABEL, PENDING_CONSENT_EVENT, pending_consent) {
        log::warn!(
            "[servers] the pending consent of {} wasn't emitted: {error}",
            pending_consent.domain
        );
    }
}

/// Bring the base's window to the front, so a consent that just arrived is
/// seen: an app on another device, or one launched from the base, is waiting
/// on it. A minimised window is restored first.
///
/// Desktop only: iOS doesn't let an app take the foreground, and Android
/// surfaces the app differently. (`cfg(desktop)` is set only for the app
/// crate, by `tauri-build`, so this gate names the mobile targets.)
#[cfg(not(any(target_os = "ios", target_os = "android")))]
fn raise_main_window<R: Runtime>(app: &AppHandle<R>) {
    use tauri::Manager;

    let Some(window) = app.get_webview_window(BASE_WEBVIEW_LABEL) else {
        log::warn!("[servers] no '{BASE_WEBVIEW_LABEL}' window to bring forward for a consent");
        return;
    };
    if matches!(window.is_minimized(), Ok(true)) {
        if let Err(error) = window.unminimize() {
            log::warn!("[servers] restoring the window for a consent failed: {error}");
        }
    }
    if let Err(error) = window.set_focus() {
        log::warn!("[servers] focusing the window for a consent failed: {error}");
    }
}

/// Mobile builds leave the window where it is: see the desktop variant.
#[cfg(any(target_os = "ios", target_os = "android"))]
fn raise_main_window<R: Runtime>(_app: &AppHandle<R>) {}
