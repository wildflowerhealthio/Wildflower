//! [`UseSignals`]: whether the app is in use, from its window events, and which
//! resumes restart every running unit.

use std::collections::BTreeSet;

/// The platform the app runs on, as far as being in use and resuming go.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UsePlatform {
    /// Linux, macOS or Windows: in use while any of the app's windows is open.
    Desktop,
    /// Android: in use while the app is in the foreground.
    Android,
    /// iOS: in use while the app is in the foreground, and a resume restarts
    /// every running unit.
    Ios,
}

impl UsePlatform {
    /// The platform this build targets.
    #[must_use]
    pub fn current() -> Self {
        if cfg!(target_os = "ios") {
            Self::Ios
        } else if cfg!(target_os = "android") {
            Self::Android
        } else {
            Self::Desktop
        }
    }

    /// Whether coming back to the foreground restarts every running unit. On
    /// iOS a suspended app's connections and listening sockets may be dead
    /// while its runs still report running (TN2277).
    #[must_use]
    #[cfg_attr(
        not(any(target_os = "ios", target_os = "android", test)),
        allow(dead_code, reason = "only phones suspend and resume")
    )]
    pub fn resume_restarts_running_units(self) -> bool {
        matches!(self, Self::Ios)
    }
}

/// What a window event means for the runner.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UseUpdate {
    /// Whether the app is in use after the event.
    pub in_use: bool,
    /// Whether the event is a resume that restarts every running unit.
    pub restart_running_units: bool,
}

/// Follows the app's windows, and its suspends and resumes on a phone.
///
/// Only a resume that follows a suspend counts as one, so the resume a window
/// reports as it first appears does nothing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UseSignals {
    platform: UsePlatform,
    open_windows: BTreeSet<String>,
    suspended: bool,
}

impl UseSignals {
    /// No windows open yet, on `platform`.
    #[must_use]
    pub fn new(platform: UsePlatform) -> Self {
        Self {
            platform,
            open_windows: BTreeSet::new(),
            suspended: false,
        }
    }

    /// The window labelled `label` opened.
    pub fn window_opened(&mut self, label: &str) -> UseUpdate {
        self.open_windows.insert(label.to_owned());
        self.update(false)
    }

    /// The window labelled `label` was destroyed.
    pub fn window_destroyed(&mut self, label: &str) -> UseUpdate {
        self.open_windows.remove(label);
        self.update(false)
    }

    /// The app went to the background (mobile).
    #[cfg_attr(
        not(any(target_os = "ios", target_os = "android", test)),
        allow(dead_code, reason = "only phones suspend and resume")
    )]
    pub fn suspended(&mut self) -> UseUpdate {
        self.suspended = true;
        self.update(false)
    }

    /// The app came back to the foreground (mobile).
    #[cfg_attr(
        not(any(target_os = "ios", target_os = "android", test)),
        allow(dead_code, reason = "only phones suspend and resume")
    )]
    pub fn resumed(&mut self) -> UseUpdate {
        let followed_a_suspend = std::mem::take(&mut self.suspended);
        self.update(followed_a_suspend && self.platform.resume_restarts_running_units())
    }

    fn update(&self, restart_running_units: bool) -> UseUpdate {
        UseUpdate {
            in_use: self.in_use(),
            restart_running_units,
        }
    }

    /// Whether the app is in use: on a desktop, any window is open, minimized
    /// included; on a phone, the app has a window and is in the foreground.
    #[must_use]
    pub fn in_use(&self) -> bool {
        let any_window_open = !self.open_windows.is_empty();
        match self.platform {
            UsePlatform::Desktop => any_window_open,
            UsePlatform::Android | UsePlatform::Ios => any_window_open && !self.suspended,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PLATFORMS: [UsePlatform; 3] =
        [UsePlatform::Desktop, UsePlatform::Android, UsePlatform::Ios];

    #[test]
    fn a_desktop_app_is_in_use_while_any_window_is_open() {
        let mut signals = UseSignals::new(UsePlatform::Desktop);
        assert!(!signals.in_use());
        assert!(signals.window_opened("main").in_use);
        assert!(signals.window_opened("settings").in_use);
        assert!(signals.window_destroyed("main").in_use);
        assert!(!signals.window_destroyed("settings").in_use);
    }

    #[test]
    fn a_phone_app_is_in_use_while_in_the_foreground() {
        for platform in [UsePlatform::Android, UsePlatform::Ios] {
            let mut signals = UseSignals::new(platform);
            assert!(signals.window_opened("main").in_use);
            assert!(!signals.suspended().in_use);
            assert!(signals.resumed().in_use);
        }
    }

    #[test]
    fn only_an_ios_resume_after_a_suspend_restarts_running_units() {
        for platform in PLATFORMS {
            let mut signals = UseSignals::new(platform);
            signals.window_opened("main");
            assert!(
                !signals.resumed().restart_running_units,
                "a resume without a suspend restarts nothing"
            );
            signals.suspended();
            assert_eq!(
                signals.resumed().restart_running_units,
                platform == UsePlatform::Ios
            );
            assert!(
                !signals.resumed().restart_running_units,
                "each suspend counts for one resume"
            );
        }
    }
}
