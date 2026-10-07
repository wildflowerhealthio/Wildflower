//! [`WindowState`]: whether the app is present, from its window events, and
//! which returns to the foreground call for restarting every running unit.

use std::collections::BTreeSet;

/// The kind of platform the app runs on, as far as being present and the
/// background go.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlatformKind {
    /// Linux, macOS or Windows: present while any of the app's windows is
    /// open.
    Desktop,
    /// Android: present while the app is in the foreground.
    Android,
    /// iOS: present while the app is in the foreground; moving to the
    /// background breaks the app's sockets.
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

    /// Whether moving the app to the background can break its sockets: on
    /// iOS a suspended app's connections and listening sockets may be dead
    /// once it returns, while its runs still report running (TN2277).
    #[must_use]
    #[cfg_attr(
        not(any(target_os = "ios", target_os = "android", test)),
        allow(dead_code, reason = "only phones move to the background")
    )]
    pub fn backgrounding_breaks_sockets(self) -> bool {
        matches!(self, Self::Ios)
    }
}

/// What a window event means for `UnitRunner`. The caller acts on it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowStateChange {
    /// Whether the app is present after the event.
    pub present_after_event: bool,
    /// Whether every running unit should restart: the app returned to the
    /// foreground on a platform where
    /// [`backgrounding_breaks_sockets`](PlatformKind::backgrounding_breaks_sockets).
    pub unit_restarts_needed: bool,
}

/// The app's open windows, and whether a phone app is in the background.
///
/// Only a return to the foreground that follows a move to the background
/// counts as one, so the resume a window reports as it first appears does
/// nothing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowState {
    platform: PlatformKind,
    open_windows: BTreeSet<String>,
    in_background: bool,
}

impl WindowState {
    /// No windows open yet, on `platform`.
    #[must_use]
    pub fn new(platform: PlatformKind) -> Self {
        Self {
            platform,
            open_windows: BTreeSet::new(),
            in_background: false,
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

    /// The app moved to the background (mobile).
    #[cfg_attr(
        not(any(target_os = "ios", target_os = "android", test)),
        allow(dead_code, reason = "only phones move to the background")
    )]
    pub fn moved_to_background(&mut self) -> WindowStateChange {
        self.in_background = true;
        self.change(false)
    }

    /// The app returned to the foreground (mobile).
    #[cfg_attr(
        not(any(target_os = "ios", target_os = "android", test)),
        allow(dead_code, reason = "only phones move to the background")
    )]
    pub fn returned_to_foreground(&mut self) -> WindowStateChange {
        let was_in_background = std::mem::take(&mut self.in_background);
        self.change(was_in_background && self.platform.backgrounding_breaks_sockets())
    }

    fn change(&self, unit_restarts_needed: bool) -> WindowStateChange {
        WindowStateChange {
            present_after_event: self.app_present(),
            unit_restarts_needed,
        }
    }

    /// Whether the app is present: on a desktop, any window is open, minimized
    /// included; on a phone, the app has a window and is in the foreground.
    #[must_use]
    pub fn app_present(&self) -> bool {
        let any_window_open = !self.open_windows.is_empty();
        match self.platform {
            PlatformKind::Desktop => any_window_open,
            PlatformKind::Android | PlatformKind::Ios => any_window_open && !self.in_background,
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
    fn a_desktop_app_is_present_while_any_window_is_open() {
        let mut window_state = WindowState::new(PlatformKind::Desktop);
        assert!(!window_state.app_present());
        assert!(window_state.window_opened("main").present_after_event);
        assert!(window_state.window_opened("settings").present_after_event);
        assert!(window_state.window_destroyed("main").present_after_event);
        assert!(
            !window_state
                .window_destroyed("settings")
                .present_after_event
        );
    }

    #[test]
    fn a_phone_app_is_present_while_in_the_foreground() {
        for platform in [PlatformKind::Android, PlatformKind::Ios] {
            let mut window_state = WindowState::new(platform);
            assert!(window_state.window_opened("main").present_after_event);
            assert!(!window_state.moved_to_background().present_after_event);
            assert!(window_state.returned_to_foreground().present_after_event);
        }
    }

    #[test]
    fn only_an_ios_return_from_the_background_needs_unit_restarts() {
        for platform in PLATFORMS {
            let mut window_state = WindowState::new(platform);
            window_state.window_opened("main");
            assert!(
                !window_state.returned_to_foreground().unit_restarts_needed,
                "a return without a move to the background restarts nothing"
            );
            window_state.moved_to_background();
            assert_eq!(
                window_state.returned_to_foreground().unit_restarts_needed,
                platform == PlatformKind::Ios
            );
            assert!(
                !window_state.returned_to_foreground().unit_restarts_needed,
                "each move to the background counts for one return"
            );
        }
    }
}
