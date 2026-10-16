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

use anyhow::Context as _;
use tauri::{AppHandle, Manager};
use tauri_plugin_log::log;

use crate::BASE_WEBVIEW_LABEL;

/// Where the count of servers with a consent request pending is shown: in
/// the app, the app icon's badge; in the tests, a record of each count.
pub(crate) trait PendingConsentBadge: Send + 'static {
    /// Show `count` on the badge, or clear it when `count` is 0.
    ///
    /// # Errors
    ///
    /// When the badge couldn't be set.
    fn show(&self, count: usize) -> anyhow::Result<()>;
}

/// The app's [`PendingConsentBadge`]: the app icon's badge, set through the
/// base's window, since the badge is the app's, not one window's.
pub(crate) struct AppIconBadge {
    pub(crate) app: AppHandle,
}

impl PendingConsentBadge for AppIconBadge {
    fn show(&self, count: usize) -> anyhow::Result<()> {
        let window = self
            .app
            .get_webview_window(BASE_WEBVIEW_LABEL)
            .context("the base's window is gone")?;
        #[cfg(desktop)]
        {
            // `None` clears the badge: macOS would show a 0.
            let badge_count = (count > 0).then(|| i64::try_from(count).unwrap_or(i64::MAX));
            window.set_badge_count(badge_count)?;
        }
        Ok(())
    }
}

/// The count a [`PendingConsentBadge`] shows, so it is set again only when
/// the count changes. None shown yet at the app's start, so the first count
/// sets it, clearing a badge left from an earlier run of the app; and none
/// known after a set that failed, so the next count tries again.
#[derive(Debug, Default)]
pub(crate) struct ShownBadgeCount(Option<usize>);

impl ShownBadgeCount {
    /// Show `count` on `badge`, unless it shows that count already. A
    /// failure is logged: the badge is the end of the line, with nothing
    /// further to report it to.
    pub(crate) fn show_on(&mut self, badge: &impl PendingConsentBadge, count: usize) {
        if self.0 == Some(count) {
            return;
        }
        match badge.show(count) {
            Ok(()) => self.0 = Some(count),
            Err(error) => {
                self.0 = None;
                log::warn!("[servers] the app badge isn't set to {count}: {error:#}");
            }
        }
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
        fn show(&self, count: usize) -> anyhow::Result<()> {
            self.0.lock().unwrap().push(count);
            Ok(())
        }
    }

    /// A badge whose sets fail while `failing` holds, recording each count it
    /// was asked to show.
    #[derive(Default)]
    struct FlakyBadge {
        failing: Mutex<bool>,
        asked: RecordedCounts,
    }

    impl PendingConsentBadge for FlakyBadge {
        fn show(&self, count: usize) -> anyhow::Result<()> {
            self.asked.show(count)?;
            if *self.failing.lock().unwrap() {
                anyhow::bail!("the base's window is gone");
            }
            Ok(())
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

    #[test]
    fn a_count_that_failed_to_show_is_tried_again() {
        let badge = FlakyBadge::default();
        let mut shown = ShownBadgeCount::default();
        shown.show_on(&badge, 0);

        *badge.failing.lock().unwrap() = true;
        shown.show_on(&badge, 1);
        *badge.failing.lock().unwrap() = false;
        shown.show_on(&badge, 1);
        shown.show_on(&badge, 1);
        assert_eq!(badge.asked.shown(), [0, 1, 1]);
    }

    #[test]
    fn a_failed_set_leaves_the_badge_unknown_so_any_count_shows_next() {
        let badge = FlakyBadge::default();
        let mut shown = ShownBadgeCount::default();
        shown.show_on(&badge, 2);

        *badge.failing.lock().unwrap() = true;
        shown.show_on(&badge, 0);
        *badge.failing.lock().unwrap() = false;
        // The failed clear may have left 2 or nothing on the badge, so 2 is
        // set again.
        shown.show_on(&badge, 2);
        assert_eq!(badge.asked.shown(), [2, 0, 2]);
    }
}
