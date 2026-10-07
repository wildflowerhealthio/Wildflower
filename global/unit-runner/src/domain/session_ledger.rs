//! [`SessionLedger`]: `UnitRunner`'s record of the background session.
//!
//! The background session is the one background-service task (an Android
//! foreground service, an iOS background task) that keeps the app alive while
//! units run. Starting and ending it are async, and the platform can also start
//! a session itself (boot recovery, an OS restart). So `UnitRunner` numbers
//! each session as it starts, and marks the one it is ending as no longer
//! needed, so that session's end counts as its own. Any other end of the
//! running session is the platform's: Android's time limit, the Stop action on
//! the notification, or iOS ending the background time. After the platform ends
//! it, runs are discouraged until the app becomes present again, a policy is
//! set, or a session starts again. That way `UnitRunner` doesn't fight the OS
//! or the user.

use crate::status::PlatformStopReason;

/// One background session, from its start to its end, numbered in the order
/// `UnitRunner` learned of them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SessionId(u64);

/// Where the background session is, as `UnitRunner` knows it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum SessionState {
    /// No session is running, and nothing discourages runs.
    #[default]
    NoSession,
    /// The platform ended the running session, and nothing has cleared that
    /// yet. No session is running, and no unit runs.
    EndedByPlatform,
    /// The session is running.
    Running(SessionId),
    /// The session is running, and `UnitRunner` is ending it because no unit
    /// should run.
    EndingAsNoLongerNeeded(SessionId),
}

/// How a background session ended, as `UnitRunner` sees it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionEnd {
    /// `UnitRunner` ended it, because no unit should run.
    NoLongerNeeded,
    /// The platform ended the running session. Every running unit stops with
    /// this reason, and none starts until that is cleared.
    EndedByPlatform(PlatformStopReason),
    /// A session that was no longer the current one finished ending.
    Stale,
}

/// `UnitRunner`'s record of the background session.
///
/// The session itself tells `UnitRunner` when it starts and ends, whoever
/// started it: `UnitRunner`, the platform's own recovery, or an iOS background
/// task. `UnitRunner` marks the session it is ending before it asks the
/// platform, so the end that follows counts as its own.
///
/// It has no lock of its own: [`UnitRunner`](crate::UnitRunner) only
/// touches it under its state lock.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionLedger {
    /// The id given to the latest session.
    last_id: u64,
    state: SessionState,
}

impl SessionLedger {
    /// No session running, nothing ended by the platform.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// A background session started. It is the running session now, whatever
    /// came before, and clears an end by the platform.
    pub fn session_started(&mut self) -> SessionId {
        self.last_id += 1;
        let id = SessionId(self.last_id);
        self.state = SessionState::Running(id);
        id
    }

    /// Record that `UnitRunner` is ending the running session, and return it.
    /// `None` when no session is running, or `UnitRunner` is already ending it.
    pub fn mark_no_longer_needed(&mut self) -> Option<SessionId> {
        let SessionState::Running(id) = self.state else {
            return None;
        };
        self.state = SessionState::EndingAsNoLongerNeeded(id);
        Some(id)
    }

    /// The background session `id` ended. `platform_reason` is the platform's
    /// reason for it, when the platform gave one that wasn't `UnitRunner`'s
    /// own.
    pub fn session_ended(
        &mut self,
        id: SessionId,
        platform_reason: Option<PlatformStopReason>,
    ) -> SessionEnd {
        match self.state {
            SessionState::Running(current) if current == id => {
                self.state = SessionState::EndedByPlatform;
                SessionEnd::EndedByPlatform(platform_reason.unwrap_or(PlatformStopReason::Unknown))
            }
            SessionState::EndingAsNoLongerNeeded(current) if current == id => {
                self.state = SessionState::NoSession;
                SessionEnd::NoLongerNeeded
            }
            SessionState::NoSession
            | SessionState::EndedByPlatform
            | SessionState::Running(_)
            | SessionState::EndingAsNoLongerNeeded(_) => SessionEnd::Stale,
        }
    }

    /// Let units start again after the platform ended the session, without a
    /// session starting again: the app became present, or the app set a policy.
    pub fn clear_ended_by_platform(&mut self) {
        if self.state == SessionState::EndedByPlatform {
            self.state = SessionState::NoSession;
        }
    }

    /// Whether the platform ended the session and nothing has cleared that
    /// since. While it has, no unit runs.
    #[must_use]
    pub fn runs_discouraged_by_platform(&self) -> bool {
        self.state == SessionState::EndedByPlatform
    }

    /// Whether a session is running and `UnitRunner` isn't ending it.
    #[must_use]
    pub fn session_running_and_not_ending(&self) -> bool {
        matches!(self.state, SessionState::Running(_))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_session_the_runner_ends_ends_as_no_longer_needed() {
        let mut ledger = SessionLedger::new();
        let id = ledger.session_started();
        assert!(ledger.session_running_and_not_ending());
        assert_eq!(ledger.mark_no_longer_needed(), Some(id));
        assert_eq!(ledger.mark_no_longer_needed(), None, "one mark per session");
        assert!(!ledger.session_running_and_not_ending());
        // Even when the platform reports a reason: it ended a session
        // `UnitRunner` was ending anyway.
        assert_eq!(
            ledger.session_ended(id, Some(PlatformStopReason::UserStop)),
            SessionEnd::NoLongerNeeded
        );
        assert!(!ledger.runs_discouraged_by_platform());
    }

    #[test]
    fn an_end_by_the_platform_discourages_runs_until_a_session_starts_again() {
        let mut ledger = SessionLedger::new();
        let id = ledger.session_started();
        assert_eq!(
            ledger.session_ended(id, Some(PlatformStopReason::PlatformExpiration)),
            SessionEnd::EndedByPlatform(PlatformStopReason::PlatformExpiration)
        );
        assert!(ledger.runs_discouraged_by_platform());
        assert!(!ledger.session_running_and_not_ending());
        ledger.session_started();
        assert!(!ledger.runs_discouraged_by_platform());
    }

    #[test]
    fn an_end_by_the_platform_without_a_reason_is_unknown() {
        let mut ledger = SessionLedger::new();
        let id = ledger.session_started();
        assert_eq!(
            ledger.session_ended(id, None),
            SessionEnd::EndedByPlatform(PlatformStopReason::Unknown)
        );
    }

    #[test]
    fn clearing_an_end_by_the_platform_lets_units_run() {
        let mut ledger = SessionLedger::new();
        let id = ledger.session_started();
        ledger.session_ended(id, Some(PlatformStopReason::NativeNotificationStop));
        assert!(ledger.runs_discouraged_by_platform());
        ledger.clear_ended_by_platform();
        assert!(!ledger.runs_discouraged_by_platform());
    }

    #[test]
    fn clearing_leaves_a_running_or_ending_session_alone() {
        let mut ledger = SessionLedger::new();
        let id = ledger.session_started();
        ledger.clear_ended_by_platform();
        assert!(ledger.session_running_and_not_ending());
        assert_eq!(ledger.mark_no_longer_needed(), Some(id));
        ledger.clear_ended_by_platform();
        assert_eq!(ledger.session_ended(id, None), SessionEnd::NoLongerNeeded);
    }

    #[test]
    fn a_late_end_of_an_earlier_session_is_stale() {
        let mut ledger = SessionLedger::new();
        let first = ledger.session_started();
        ledger.mark_no_longer_needed();
        let second = ledger.session_started();
        // The first was marked, but it is no longer the current session.
        assert_eq!(ledger.session_ended(first, None), SessionEnd::Stale);
        assert!(
            ledger.session_running_and_not_ending(),
            "the second session is still running"
        );

        let third = ledger.session_started();
        assert_eq!(
            ledger.session_ended(second, Some(PlatformStopReason::PlatformExpiration)),
            SessionEnd::Stale
        );
        assert!(!ledger.runs_discouraged_by_platform());
        assert!(ledger.session_running_and_not_ending());
        assert_eq!(
            ledger.session_ended(third, None),
            SessionEnd::EndedByPlatform(PlatformStopReason::Unknown)
        );
    }
}
