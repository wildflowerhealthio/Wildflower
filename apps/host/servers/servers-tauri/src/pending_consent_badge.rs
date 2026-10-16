//! The app icon's badge: how many servers have a consent request pending
//! ([`ConsentNotificationCoalescer::pending_server_count`]), shown while any
//! does, and cleared once none does: the dock's badge on macOS, the
//! launcher's on a Linux desktop that shows one, and the app icon's on iOS.
//! Windows and Android show no badge count, so the badge is set there to no
//! effect. The consent notifications' task sets it, from the coalescer that
//! decides them, so the count holds through a stopped run as the
//! notifications do.
//!
//! [`ConsentNotificationCoalescer::pending_server_count`]: wildflowerhealthio_servers::ConsentNotificationCoalescer::pending_server_count

use tauri::{AppHandle, Manager};
use tauri_plugin_log::log;

use crate::BASE_WEBVIEW_LABEL;

/// Where the count of servers with a consent request pending is shown: in
/// the app, the app icon's badge; in the tests, a record of each count.
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

/// The count a [`PendingConsentBadge`] shows, so it is set again only when
/// the count changes. None shown yet at the app's start, so the first count
/// sets it, clearing a badge left from an earlier run of the app.
#[derive(Debug, Default)]
pub(crate) struct ShownBadgeCount(Option<usize>);

impl ShownBadgeCount {
    /// Show `count` on `badge`, unless it shows that count already.
    pub(crate) fn show_on(&mut self, badge: &impl PendingConsentBadge, count: usize) {
        if self.0 == Some(count) {
            return;
        }
        badge.show(count);
        self.0 = Some(count);
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;

    /// Each count shown, in order.
    #[derive(Clone, Default)]
    pub(crate) struct RecordedCounts(Arc<Mutex<Vec<usize>>>);

    impl PendingConsentBadge for RecordedCounts {
        fn show(&self, count: usize) {
            self.0.lock().unwrap().push(count);
        }
    }

    impl RecordedCounts {
        pub(crate) fn shown(&self) -> Vec<usize> {
            self.0.lock().unwrap().clone()
        }
    }

    #[test]
    fn the_first_count_is_shown_and_a_count_already_shown_is_not() {
        let badge = RecordedCounts::default();
        let mut shown = ShownBadgeCount::default();
        shown.show_on(&badge, 0);
        shown.show_on(&badge, 0);
        shown.show_on(&badge, 2);
        shown.show_on(&badge, 2);
        shown.show_on(&badge, 0);
        assert_eq!(badge.shown(), [0, 2, 0]);
    }
}
