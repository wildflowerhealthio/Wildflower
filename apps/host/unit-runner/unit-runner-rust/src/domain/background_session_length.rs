//! [`BackgroundSessionLength`]: how long the platform's background session can
//! keep the app alive after it becomes absent, and what that means for runs
//! and for when a session is wanted.

use crate::domain::app_presence::Presence;

/// How long the platform's background session can keep the app alive after
/// the app becomes absent. The host chooses it for its platform.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum BackgroundSessionLength {
    /// As long as some unit should run, until the platform ends it: a desktop,
    /// or iOS, which ends the session itself when its background time runs
    /// out. A session is wanted whenever some unit should run, the app present
    /// or not, and every policy means what it says.
    #[default]
    AsLongAsNeeded,
    /// Only the grace period: an Android `shortService`, which the platform
    /// times out after 3 minutes, so it isn't started while the platform
    /// keeps the app alive, where it would time out with the app on screen. A
    /// session is wanted only while some unit should run and the platform
    /// doesn't keep the app alive: the app is absent, or present in the
    /// background. While the app is absent, every policy that wants a unit
    /// running wants it only for the grace period, as `WhileOpen` does.
    GracePeriod,
}

impl BackgroundSessionLength {
    /// Whether a unit whose policy wants it running may run, given whether the
    /// app is present or became absent less than the grace period ago. A
    /// session that lasts only the grace period can't keep the app alive past
    /// it, so no unit runs once it has ended.
    #[must_use]
    pub fn lets_units_run(self, app_present_or_in_grace: bool) -> bool {
        match self {
            Self::AsLongAsNeeded => true,
            Self::GracePeriod => app_present_or_in_grace,
        }
    }

    /// Whether a background session is wanted, given whether some unit should
    /// run and the app's `presence`. A session that lasts only the grace
    /// period is wanted only while the platform doesn't keep the app alive, so
    /// it starts as the grace period does, or as the app moves to the
    /// background while still present.
    #[must_use]
    pub fn wants_session(self, some_unit_should_run: bool, presence: Presence) -> bool {
        some_unit_should_run
            && match self {
                Self::AsLongAsNeeded => true,
                Self::GracePeriod => presence != Presence::Present,
            }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PRESENCES: [Presence; 3] = [
        Presence::Absent,
        Presence::Present,
        Presence::PresentInBackground,
    ];

    #[test]
    fn a_session_as_long_as_needed_lets_units_run_and_is_wanted_whenever_one_should() {
        let length = BackgroundSessionLength::AsLongAsNeeded;
        for app_present in [false, true] {
            assert!(length.lets_units_run(app_present));
        }
        for presence in PRESENCES {
            assert!(length.wants_session(true, presence), "{presence:?}");
            assert!(!length.wants_session(false, presence), "{presence:?}");
        }
    }

    #[test]
    fn a_grace_period_session_lets_units_run_only_while_present_or_in_grace() {
        let length = BackgroundSessionLength::GracePeriod;
        assert!(length.lets_units_run(true));
        assert!(!length.lets_units_run(false));
    }

    #[test]
    fn a_grace_period_session_is_wanted_only_while_the_platform_doesn_t_keep_the_app_alive() {
        let length = BackgroundSessionLength::GracePeriod;
        assert!(length.wants_session(true, Presence::Absent));
        assert!(length.wants_session(true, Presence::PresentInBackground));
        assert!(!length.wants_session(true, Presence::Present));
        for presence in PRESENCES {
            assert!(!length.wants_session(false, presence), "{presence:?}");
        }
    }
}
