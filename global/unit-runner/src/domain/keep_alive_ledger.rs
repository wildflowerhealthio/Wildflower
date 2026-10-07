//! [`KeepAliveLedger`]: the runner's record of the keep-alive task.
//!
//! The keep-alive is the one background-service task (an Android foreground
//! service, an iOS background task) that keeps the app alive while units run.
//! Starting and stopping it are async, and the platform can also start the task
//! itself (boot recovery, an OS restart). So the runner numbers each task as
//! it starts, and remembers which one it asked to stop, so that task's end
//! counts as its own. Any other end of the current task is a revocation by the
//! platform: Android's time limit, the Stop action on the notification, or iOS
//! ending the background time. After a revocation, units stay stopped until
//! the app opens again, a policy is set, or the keep-alive starts again. That
//! way the runner doesn't fight the OS or the user.

use crate::status::PlatformStopReason;

/// One keep-alive task, from its start to its end, numbered in the order the
/// runner learned of them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct KeepAliveId(u64);

/// How a keep-alive task ended, as the runner sees it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeepAliveEnd {
    /// The runner asked it to stop, because no unit should run.
    Released,
    /// The platform ended the current task. Every running unit stops with
    /// this reason, and none starts until the revocation is cleared.
    Revoked(PlatformStopReason),
    /// An earlier task, already replaced or released, finished ending.
    Superseded,
}

/// The runner's record of the keep-alive task.
///
/// The task itself tells the runner when it starts and ends, whoever started
/// it: the runner, the platform's own recovery, or an iOS background task. The
/// runner records which task it is stopping before it asks the platform, so
/// the end that follows counts as its own.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct KeepAliveLedger {
    /// The id given to the latest task.
    last_id: u64,
    /// The task that is running, if any.
    current: Option<KeepAliveId>,
    /// The task the runner asked to stop, until it ends.
    release_requested: Option<KeepAliveId>,
    /// The platform ended the current task, and nothing has cleared that yet.
    revoked_by_platform: bool,
}

impl KeepAliveLedger {
    /// No task running, nothing revoked.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// A keep-alive task started. It is the current task now, and it clears
    /// an earlier revocation.
    pub fn task_started(&mut self) -> KeepAliveId {
        self.last_id += 1;
        let id = KeepAliveId(self.last_id);
        self.current = Some(id);
        self.revoked_by_platform = false;
        id
    }

    /// Record that the runner is stopping the current task, and return it.
    /// `None` when no task is running, or the runner already asked it to stop.
    pub fn request_release(&mut self) -> Option<KeepAliveId> {
        let current = self.current?;
        if self.release_requested == Some(current) {
            return None;
        }
        self.release_requested = Some(current);
        Some(current)
    }

    /// The keep-alive task `id` ended. `platform_reason` is the platform's
    /// reason for it, when the platform gave one that wasn't the runner's own.
    pub fn task_ended(
        &mut self,
        id: KeepAliveId,
        platform_reason: Option<PlatformStopReason>,
    ) -> KeepAliveEnd {
        let was_current = self.current == Some(id);
        if was_current {
            self.current = None;
        }
        if self.release_requested == Some(id) {
            self.release_requested = None;
            return KeepAliveEnd::Released;
        }
        if !was_current {
            return KeepAliveEnd::Superseded;
        }
        self.revoked_by_platform = true;
        KeepAliveEnd::Revoked(platform_reason.unwrap_or(PlatformStopReason::Unknown))
    }

    /// Let units start again after a revocation, without the keep-alive
    /// starting again: the app opened, or the app set a policy.
    pub fn clear_revocation(&mut self) {
        self.revoked_by_platform = false;
    }

    /// Whether the platform ended the keep-alive and nothing has cleared that
    /// since. While it is revoked, no unit runs.
    #[must_use]
    pub fn is_revoked(&self) -> bool {
        self.revoked_by_platform
    }

    /// Whether a task is running and the runner hasn't asked it to stop.
    #[must_use]
    pub fn is_kept(&self) -> bool {
        self.current.is_some() && self.current != self.release_requested
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_task_the_runner_releases_ends_as_its_own() {
        let mut ledger = KeepAliveLedger::new();
        let id = ledger.task_started();
        assert!(ledger.is_kept());
        assert_eq!(ledger.request_release(), Some(id));
        assert_eq!(ledger.request_release(), None, "one release per task");
        assert!(!ledger.is_kept());
        // Even when the platform reports a reason: it stopped a task the
        // runner was stopping anyway.
        assert_eq!(
            ledger.task_ended(id, Some(PlatformStopReason::UserStop)),
            KeepAliveEnd::Released
        );
        assert!(!ledger.is_revoked());
    }

    #[test]
    fn a_revocation_stops_units_until_the_keep_alive_starts_again() {
        let mut ledger = KeepAliveLedger::new();
        let id = ledger.task_started();
        assert_eq!(
            ledger.task_ended(id, Some(PlatformStopReason::PlatformExpiration)),
            KeepAliveEnd::Revoked(PlatformStopReason::PlatformExpiration)
        );
        assert!(ledger.is_revoked());
        assert!(!ledger.is_kept());
        ledger.task_started();
        assert!(!ledger.is_revoked());
    }

    #[test]
    fn a_revocation_without_a_reason_is_unknown() {
        let mut ledger = KeepAliveLedger::new();
        let id = ledger.task_started();
        assert_eq!(
            ledger.task_ended(id, None),
            KeepAliveEnd::Revoked(PlatformStopReason::Unknown)
        );
    }

    #[test]
    fn clearing_a_revocation_lets_units_run() {
        let mut ledger = KeepAliveLedger::new();
        let id = ledger.task_started();
        ledger.task_ended(id, Some(PlatformStopReason::NativeNotificationStop));
        assert!(ledger.is_revoked());
        ledger.clear_revocation();
        assert!(!ledger.is_revoked());
    }

    #[test]
    fn an_old_task_ending_after_a_new_one_started_is_superseded() {
        let mut ledger = KeepAliveLedger::new();
        let first = ledger.task_started();
        ledger.request_release();
        let second = ledger.task_started();
        assert_eq!(ledger.task_ended(first, None), KeepAliveEnd::Released);
        assert!(ledger.is_kept(), "the second task is still running");

        let third = ledger.task_started();
        assert_eq!(
            ledger.task_ended(second, Some(PlatformStopReason::PlatformExpiration)),
            KeepAliveEnd::Superseded
        );
        assert!(!ledger.is_revoked());
        assert!(ledger.is_kept());
        assert_eq!(
            ledger.task_ended(third, None),
            KeepAliveEnd::Revoked(PlatformStopReason::Unknown)
        );
    }
}
