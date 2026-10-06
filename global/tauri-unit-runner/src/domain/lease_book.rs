//! [`LeaseBook`]: which lease the runner holds, which one it is releasing, and
//! whether the platform has ended it.

use crate::status::PlatformStopReason;

/// One start-to-end of the lease, numbered in the order the runner was handed
/// them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct LeaseId(u64);

/// How a lease ended, as the runner sees it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LeaseEnd {
    /// The runner released it, because no unit should run.
    ReleasedByRunner,
    /// The platform ended the lease the runner holds. Every running unit stops
    /// with this reason and none starts until the lease comes back.
    EndedByPlatform(PlatformStopReason),
    /// An earlier lease, already replaced or released, finished ending.
    Stale,
}

/// The runner's record of the lease.
///
/// The lease is handed over by the lease task itself, whoever started it (the
/// runner, the plugin's recovery, an iOS background task), and taken back when
/// that task ends. The runner marks the lease it is releasing before it asks
/// the platform, so the end that follows is its own.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LeaseBook {
    issued: u64,
    held: Option<LeaseId>,
    releasing: Option<LeaseId>,
    ended_by_platform: bool,
}

impl LeaseBook {
    /// No lease held, none lost.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// A lease task began: the runner holds the lease again, and a lease the
    /// platform ended earlier no longer keeps units from starting.
    pub fn gained(&mut self) -> LeaseId {
        self.issued += 1;
        let lease = LeaseId(self.issued);
        self.held = Some(lease);
        self.ended_by_platform = false;
        lease
    }

    /// Mark the held lease as being released by the runner, and return it; or
    /// `None` when there is none to release, or it is already being released.
    pub fn begin_release(&mut self) -> Option<LeaseId> {
        let held = self.held?;
        if self.releasing == Some(held) {
            return None;
        }
        self.releasing = Some(held);
        Some(held)
    }

    /// The lease task for `lease` ended. `platform_reason` is the platform's
    /// reason for it, when the platform gave one that wasn't the runner's own.
    pub fn ended(
        &mut self,
        lease: LeaseId,
        platform_reason: Option<PlatformStopReason>,
    ) -> LeaseEnd {
        let held = self.held == Some(lease);
        if held {
            self.held = None;
        }
        if self.releasing == Some(lease) {
            self.releasing = None;
            return LeaseEnd::ReleasedByRunner;
        }
        if !held {
            return LeaseEnd::Stale;
        }
        self.ended_by_platform = true;
        LeaseEnd::EndedByPlatform(platform_reason.unwrap_or(PlatformStopReason::Unknown))
    }

    /// Let units start again after the platform ended the lease, without the
    /// lease coming back: the app came back into use, or set a policy.
    pub fn forget_platform_end(&mut self) {
        self.ended_by_platform = false;
    }

    /// Whether units may run: the platform hasn't ended the lease since the
    /// runner last held it, came back into use, or had a policy set.
    #[must_use]
    pub fn allows_runs(&self) -> bool {
        !self.ended_by_platform
    }

    /// Whether the runner holds a lease it isn't releasing.
    #[must_use]
    pub fn holds_and_keeps(&self) -> bool {
        self.held.is_some() && self.held != self.releasing
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_lease_the_runner_releases_ends_as_its_own() {
        let mut book = LeaseBook::new();
        let lease = book.gained();
        assert!(book.holds_and_keeps());
        assert_eq!(book.begin_release(), Some(lease));
        assert_eq!(book.begin_release(), None, "one release per lease");
        assert!(!book.holds_and_keeps());
        // Even when the platform reports a reason: it stopped a lease the
        // runner was letting go of anyway.
        assert_eq!(
            book.ended(lease, Some(PlatformStopReason::UserStop)),
            LeaseEnd::ReleasedByRunner
        );
        assert!(book.allows_runs());
    }

    #[test]
    fn a_lease_the_platform_ends_stops_units_until_it_comes_back() {
        let mut book = LeaseBook::new();
        let lease = book.gained();
        assert_eq!(
            book.ended(lease, Some(PlatformStopReason::PlatformExpiration)),
            LeaseEnd::EndedByPlatform(PlatformStopReason::PlatformExpiration)
        );
        assert!(!book.allows_runs());
        assert!(!book.holds_and_keeps());
        book.gained();
        assert!(book.allows_runs());
    }

    #[test]
    fn a_platform_end_without_a_reason_is_unknown() {
        let mut book = LeaseBook::new();
        let lease = book.gained();
        assert_eq!(
            book.ended(lease, None),
            LeaseEnd::EndedByPlatform(PlatformStopReason::Unknown)
        );
    }

    #[test]
    fn coming_back_into_use_forgets_a_platform_end() {
        let mut book = LeaseBook::new();
        let lease = book.gained();
        book.ended(lease, Some(PlatformStopReason::NativeNotificationStop));
        book.forget_platform_end();
        assert!(book.allows_runs());
    }

    #[test]
    fn an_old_lease_ending_after_a_new_one_began_is_stale() {
        let mut book = LeaseBook::new();
        let first = book.gained();
        book.begin_release();
        let second = book.gained();
        assert_eq!(book.ended(first, None), LeaseEnd::ReleasedByRunner);
        assert!(book.holds_and_keeps(), "the second lease is still held");

        let third = book.gained();
        assert_eq!(
            book.ended(second, Some(PlatformStopReason::PlatformExpiration)),
            LeaseEnd::Stale
        );
        assert!(book.allows_runs());
        assert!(book.holds_and_keeps());
        assert_eq!(
            book.ended(third, None),
            LeaseEnd::EndedByPlatform(PlatformStopReason::Unknown)
        );
    }
}
