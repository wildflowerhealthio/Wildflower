//! What the host does with the server when the app leaves the screen on a
//! phone and when it comes back to the foreground.

use crate::domain::notification::LocalNotification;
use crate::domain::server_run_state::ServerRunState;
use crate::domain::stop_notification::background_pause_notification;

/// What a foreground resume does to the server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResumeAction {
    /// The server is stopped: start it.
    Start,
    /// The server reports it is running, but the platform may have reclaimed
    /// its listening socket while the app was suspended: restart it.
    Restart,
}

/// Follows the main window's suspend and resume, and decides what each resume
/// does.
///
/// Only a resume that follows a suspend counts, so the resume a window reports
/// as it first appears does nothing.
#[derive(Debug, Default)]
pub struct ForegroundResume {
    suspended: bool,
}

impl ForegroundResume {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// The app went to the background with the server in `run_state`.
    /// Returns the warning to post when `listener_may_be_reclaimed`, which is
    /// also the platform that suspends a backgrounded app (iOS), and the
    /// server is serving or about to.
    pub fn suspended(
        &mut self,
        run_state: &ServerRunState,
        listener_may_be_reclaimed: bool,
    ) -> Option<LocalNotification> {
        self.suspended = true;
        match run_state {
            ServerRunState::Stopped { .. } => None,
            ServerRunState::Starting | ServerRunState::Running => {
                listener_may_be_reclaimed.then(background_pause_notification)
            }
        }
    }

    /// The app came back to the foreground with the server in `run_state`.
    /// `listener_may_be_reclaimed` is whether the platform reclaims a
    /// suspended app's listening sockets (iOS, TN2277), which leaves a server
    /// that reports running but accepts nothing.
    pub fn resumed(
        &mut self,
        run_state: &ServerRunState,
        listener_may_be_reclaimed: bool,
    ) -> Option<ResumeAction> {
        if !std::mem::take(&mut self.suspended) {
            return None;
        }
        match run_state {
            ServerRunState::Stopped { .. } => Some(ResumeAction::Start),
            ServerRunState::Starting | ServerRunState::Running => {
                listener_may_be_reclaimed.then_some(ResumeAction::Restart)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RUN_STATES: [ServerRunState; 3] = [
        ServerRunState::Starting,
        ServerRunState::Running,
        ServerRunState::Stopped { error: None },
    ];

    #[test]
    fn a_resume_without_a_suspend_does_nothing() {
        for run_state in RUN_STATES {
            for listener_may_be_reclaimed in [false, true] {
                let mut foreground = ForegroundResume::new();
                assert_eq!(
                    foreground.resumed(&run_state, listener_may_be_reclaimed),
                    None
                );
            }
        }
    }

    #[test]
    fn a_stopped_server_starts_on_resume() {
        for listener_may_be_reclaimed in [false, true] {
            let mut foreground = ForegroundResume::new();
            foreground.suspended(&ServerRunState::Running, false);
            assert_eq!(
                foreground.resumed(
                    &ServerRunState::Stopped {
                        error: Some("bind failed".to_owned())
                    },
                    listener_may_be_reclaimed
                ),
                Some(ResumeAction::Start)
            );
        }
    }

    #[test]
    fn a_running_server_restarts_only_where_its_listener_may_be_gone() {
        let mut foreground = ForegroundResume::new();
        foreground.suspended(&ServerRunState::Running, false);
        assert_eq!(
            foreground.resumed(&ServerRunState::Running, true),
            Some(ResumeAction::Restart)
        );

        foreground.suspended(&ServerRunState::Running, false);
        assert_eq!(foreground.resumed(&ServerRunState::Running, false), None);
    }

    #[test]
    fn each_suspend_counts_for_one_resume() {
        let mut foreground = ForegroundResume::new();
        foreground.suspended(&ServerRunState::Running, false);
        let stopped = ServerRunState::Stopped { error: None };
        assert_eq!(
            foreground.resumed(&stopped, false),
            Some(ResumeAction::Start)
        );
        assert_eq!(foreground.resumed(&stopped, false), None);
    }

    #[test]
    fn leaving_the_screen_warns_only_where_a_serving_server_is_suspended() {
        for run_state in RUN_STATES {
            for listener_may_be_reclaimed in [false, true] {
                let mut foreground = ForegroundResume::new();
                let warning = foreground.suspended(&run_state, listener_may_be_reclaimed);
                let serving = !matches!(run_state, ServerRunState::Stopped { .. });
                assert_eq!(
                    warning,
                    (serving && listener_may_be_reclaimed).then(background_pause_notification),
                    "{run_state:?}, listener_may_be_reclaimed: {listener_may_be_reclaimed}"
                );
            }
        }
    }
}
