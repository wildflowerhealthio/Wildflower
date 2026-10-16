//! The app icon's badge: how many servers have a consent waiting on them
//! ([`pending_consent_server_count`]), shown while any does, and cleared once
//! none does: the dock's badge on macOS, the launcher's on a Linux desktop
//! that shows one, and the app icon's on iOS. Windows and Android show no
//! badge count, so the badge is set there to no effect.

use tauri::{AppHandle, Manager};
use tauri_plugin_log::log;
use tokio::sync::watch;
use wildflowerhealthio_servers::{pending_consent_server_count, ServerDetail};
use wildflowerhealthio_tauri_unit_runner::UnitStatuses;

use crate::BASE_WEBVIEW_LABEL;

/// Where the count of servers with a consent waiting is shown: in the app,
/// the app icon's badge; in the tests, a record of each count.
pub(crate) trait PendingConsentBadge: Send + 'static {
    /// Show `count` on the badge, or clear it when `count` is 0.
    fn show(&self, count: usize);
}

/// The app's [`PendingConsentBadge`]: the app icon's badge, set through the
/// base's window, since the badge is the app's, not one window's.
pub(crate) struct AppIconBadge {
    pub(crate) app: AppHandle,
}

impl PendingConsentBadge for AppIconBadge {
    /// A failure is logged: the badge is the end of the line, with nothing
    /// further to report it to.
    fn show(&self, count: usize) {
        let Some(window) = self.app.get_webview_window(BASE_WEBVIEW_LABEL) else {
            log::warn!("[servers] the base's window is gone; the app badge isn't set to {count}");
            return;
        };
        // `None` clears the badge: macOS would show a 0.
        let badge_count = (count > 0).then(|| i64::try_from(count).unwrap_or(i64::MAX));
        if let Err(error) = window.set_badge_count(badge_count) {
            log::warn!("[servers] setting the app badge to {count} failed: {error}");
        }
    }
}

/// Show on `badge` how many servers have a consent waiting, every time
/// `TauriUnitRunner`'s statuses change and that count does. The first
/// statuses read always set it, so a badge left from an earlier run of the
/// app is cleared.
pub(crate) async fn show_pending_consent_count(
    badge: impl PendingConsentBadge,
    mut statuses: watch::Receiver<UnitStatuses<ServerDetail>>,
) {
    let mut shown_count = None;
    loop {
        let count = pending_consent_server_count(&statuses.borrow_and_update());
        if shown_count != Some(count) {
            badge.show(count);
            shown_count = Some(count);
        }
        if statuses.changed().await.is_err() {
            log::error!("[servers] the unit runner's statuses closed; the app badge stopped");
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use wildflowerhealthio_authorization_server::NewestPendingConsent;
    use wildflowerhealthio_tauri_unit_runner::{RunState, UnitId, UnitStatus};

    use super::*;

    const RUTH: &str = "ruth.relay.example.com";
    const LAB: &str = "lab.rathole.example.com";

    /// Each count shown, in order.
    #[derive(Clone, Default)]
    struct RecordedCounts(Arc<Mutex<Vec<usize>>>);

    impl PendingConsentBadge for RecordedCounts {
        fn show(&self, count: usize) {
            self.0.lock().unwrap().push(count);
        }
    }

    impl RecordedCounts {
        fn shown(&self) -> Vec<usize> {
            self.0.lock().unwrap().clone()
        }
    }

    /// A running server's status, the request `newest` the newest waiting
    /// there, if any.
    fn running_with(newest: Option<&str>) -> UnitStatus<ServerDetail> {
        let detail = ServerDetail {
            health: None,
            tunnel: None,
            certificate: None,
            pending_consent: newest.map(|id| NewestPendingConsent::OAuth {
                id: id.to_owned(),
                client_name: "Lifting".to_owned(),
                requested_by_owner_browser: false,
            }),
            launch_minter: None,
            sign_in_code_minter: None,
            consent_watcher: None,
        };
        UnitStatus {
            run_state: RunState::Running,
            running_since: None,
            detail: Some(detail),
        }
    }

    fn statuses(
        entries: impl IntoIterator<Item = (&'static str, UnitStatus<ServerDetail>)>,
    ) -> UnitStatuses<ServerDetail> {
        entries
            .into_iter()
            .map(|(domain, status)| (UnitId::new(domain), status))
            .collect()
    }

    /// Send `statuses`, then yield to the badge's task, on the test's one
    /// thread, until it is waiting for the next change again.
    async fn send_and_let_it_read(
        statuses_tx: &watch::Sender<UnitStatuses<ServerDetail>>,
        statuses: UnitStatuses<ServerDetail>,
    ) {
        statuses_tx.send(statuses).unwrap();
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test]
    async fn the_badge_follows_the_servers_with_a_request_waiting_and_clears() {
        let (statuses_tx, statuses_rx) = watch::channel(statuses([(RUTH, running_with(None))]));
        let recorded = RecordedCounts::default();
        let showing = tokio::spawn(show_pending_consent_count(recorded.clone(), statuses_rx));
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
        // The first statuses clear a badge left from before.
        assert_eq!(recorded.shown(), [0]);

        // A new request on one server, then on another.
        send_and_let_it_read(&statuses_tx, statuses([(RUTH, running_with(Some("a")))])).await;
        send_and_let_it_read(
            &statuses_tx,
            statuses([
                (RUTH, running_with(Some("a"))),
                (LAB, running_with(Some("b"))),
            ]),
        )
        .await;
        assert_eq!(recorded.shown(), [0, 1, 2]);

        // A newer request on a server already counted leaves the count as
        // it is, so the badge isn't set again.
        send_and_let_it_read(
            &statuses_tx,
            statuses([
                (RUTH, running_with(Some("c"))),
                (LAB, running_with(Some("b"))),
            ]),
        )
        .await;
        assert_eq!(recorded.shown(), [0, 1, 2]);

        // One is decided, and the other expires: either leaves its server
        // with nothing waiting, and the badge clears.
        send_and_let_it_read(
            &statuses_tx,
            statuses([(RUTH, running_with(None)), (LAB, running_with(Some("b")))]),
        )
        .await;
        send_and_let_it_read(
            &statuses_tx,
            statuses([(RUTH, running_with(None)), (LAB, running_with(None))]),
        )
        .await;
        drop(statuses_tx);
        showing.await.unwrap();

        assert_eq!(recorded.shown(), [0, 1, 2, 1, 0]);
    }
}
