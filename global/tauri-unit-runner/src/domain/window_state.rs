//! [`WindowState`]: whether the app is open, from its window events, and which
//! resumes call for restarting every running unit.

use std::collections::BTreeSet;

/// The kind of platform the app runs on, as far as being open and resuming go.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlatformKind {
    /// Linux, macOS or Windows: open while any of the app's windows is open.
    Desktop,
    /// Android: open while the app is in the foreground.
    Android,
    /// iOS: open while the app is in the foreground, and a resume restarts
    /// every running unit.
    Ios,
}

impl PlatformKind {
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

/// What a window event means for `TauriUnitRunner`. The caller acts on it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowStateChange {
    /// Whether the app is open after the event.
    pub open_after_event: bool,
    /// Whether the event is a resume that calls for restarting every running
    /// unit.
    pub unit_restarts_needed: bool,
}

/// The app's open windows, and whether a phone app is suspended.
///
/// Only a resume that follows a suspend counts as one, so the resume a window
/// reports as it first appears does nothing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowState {
    platform: PlatformKind,
    open_windows: BTreeSet<String>,
    suspended: bool,
}

impl WindowState {
    /// No windows open yet, on `platform`.
    #[must_use]
    pub fn new(platform: PlatformKind) -> Self {
        Self {
            platform,
            open_windows: BTreeSet::new(),
            suspended: false,
        }
    }

    /// The window labelled `label` opened.
    pub fn window_opened(&mut self, label: &str) -> WindowStateChange {
        self.open_windows.insert(label.to_owned());
        self.change(false)
    }

    /// The window labelled `label` was destroyed.
    pub fn window_destroyed(&mut self, label: &str) -> WindowStateChange {
        self.open_windows.remove(label);
        self.change(false)
    }

    /// The app went to the background (mobile).
    #[cfg_attr(
        not(any(target_os = "ios", target_os = "android", test)),
        allow(dead_code, reason = "only phones suspend and resume")
    )]
    pub fn suspended(&mut self) -> WindowStateChange {
        self.suspended = true;
        self.change(false)
    }

    /// The app came back to the foreground (mobile).
    #[cfg_attr(
        not(any(target_os = "ios", target_os = "android", test)),
        allow(dead_code, reason = "only phones suspend and resume")
    )]
    pub fn resumed(&mut self) -> WindowStateChange {
        let followed_a_suspend = std::mem::take(&mut self.suspended);
        self.change(followed_a_suspend && self.platform.resume_restarts_running_units())
    }

    fn change(&self, unit_restarts_needed: bool) -> WindowStateChange {
        WindowStateChange {
            open_after_event: self.app_open(),
            unit_restarts_needed,
        }
    }

    /// Whether the app is open: on a desktop, any window is open, minimized
    /// included; on a phone, the app has a window and is in the foreground.
    #[must_use]
    pub fn app_open(&self) -> bool {
        let any_window_open = !self.open_windows.is_empty();
        match self.platform {
            PlatformKind::Desktop => any_window_open,
            PlatformKind::Android | PlatformKind::Ios => any_window_open && !self.suspended,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PLATFORMS: [PlatformKind; 3] = [
        PlatformKind::Desktop,
        PlatformKind::Android,
        PlatformKind::Ios,
    ];

    #[test]
    fn a_desktop_app_is_open_while_any_window_is_open() {
        let mut windows = WindowState::new(PlatformKind::Desktop);
        assert!(!windows.app_open());
        assert!(windows.window_opened("main").open_after_event);
        assert!(windows.window_opened("settings").open_after_event);
        assert!(windows.window_destroyed("main").open_after_event);
        assert!(!windows.window_destroyed("settings").open_after_event);
    }

    #[test]
    fn a_phone_app_is_open_while_in_the_foreground() {
        for platform in [PlatformKind::Android, PlatformKind::Ios] {
            let mut windows = WindowState::new(platform);
            assert!(windows.window_opened("main").open_after_event);
            assert!(!windows.suspended().open_after_event);
            assert!(windows.resumed().open_after_event);
        }
    }

    #[test]
    fn only_an_ios_resume_after_a_suspend_needs_a_restart() {
        for platform in PLATFORMS {
            let mut windows = WindowState::new(platform);
            windows.window_opened("main");
            assert!(
                !windows.resumed().unit_restarts_needed,
                "a resume without a suspend restarts nothing"
            );
            windows.suspended();
            assert_eq!(
                windows.resumed().unit_restarts_needed,
                platform == PlatformKind::Ios
            );
            assert!(
                !windows.resumed().unit_restarts_needed,
                "each suspend counts for one resume"
            );
        }
    }
}
