//! [`AppUse`]: whether the app is in use, and the grace period `WhileInUse`
//! units keep running for after it stops being in use.

use std::time::Duration;

use chrono::{DateTime, TimeDelta, Utc};

/// How long a `WhileInUse` unit keeps running after the app stops being in
/// use, measured on the wall clock. A short trip away from the app (a closed
/// window reopened, a phone briefly locked) doesn't stop it.
pub const WHILE_IN_USE_GRACE: Duration = Duration::from_secs(2 * 60);

/// How the app's use changed with an update.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UseChange {
    /// The app was not in use and now is.
    CameIntoUse,
    /// The app was in use and now isn't; the grace period starts.
    LeftUse,
    /// No change.
    Unchanged,
}

/// Whether the app is in use, and when it last stopped being in use.
///
/// The app starts out not in use with no grace period, so a `WhileInUse` unit
/// starts once the app's first window opens (desktop) or the app is in the
/// foreground (mobile).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AppUse {
    in_use: bool,
    left_use_at: Option<DateTime<Utc>>,
}

impl AppUse {
    /// The app not in use, with no grace period running.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Record that the app is or isn't in use as of the wall-clock instant
    /// `now`.
    pub fn update(&mut self, in_use: bool, now: DateTime<Utc>) -> UseChange {
        match (self.in_use, in_use) {
            (false, true) => {
                self.in_use = true;
                self.left_use_at = None;
                UseChange::CameIntoUse
            }
            (true, false) => {
                self.in_use = false;
                self.left_use_at = Some(now);
                UseChange::LeftUse
            }
            (true, true) | (false, false) => UseChange::Unchanged,
        }
    }

    /// Whether the app is in use, or stopped being in use less than
    /// [`WHILE_IN_USE_GRACE`] before the wall-clock instant `now`.
    #[must_use]
    pub fn in_use_or_in_grace(&self, now: DateTime<Utc>) -> bool {
        self.in_use || self.grace_ends_at().is_some_and(|ends_at| now < ends_at)
    }

    /// When the current grace period ends, or `None` while the app is in use or
    /// before it has ever been.
    #[must_use]
    pub fn grace_ends_at(&self) -> Option<DateTime<Utc>> {
        let grace = TimeDelta::from_std(WHILE_IN_USE_GRACE).expect("the grace fits a TimeDelta");
        self.left_use_at.map(|left_use_at| left_use_at + grace)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn instant(seconds: i64) -> DateTime<Utc> {
        DateTime::from_timestamp(1_800_000_000 + seconds, 0).expect("a valid instant")
    }

    const GRACE_SECONDS: i64 = 120;

    #[test]
    fn the_app_starts_out_not_in_use_with_no_grace() {
        let app_use = AppUse::new();
        assert!(!app_use.in_use_or_in_grace(instant(0)));
        assert_eq!(app_use.grace_ends_at(), None);
    }

    #[test]
    fn leaving_use_starts_the_grace_and_returning_ends_it() {
        let mut app_use = AppUse::new();
        assert_eq!(app_use.update(true, instant(0)), UseChange::CameIntoUse);
        assert_eq!(app_use.update(true, instant(1)), UseChange::Unchanged);
        assert_eq!(app_use.update(false, instant(10)), UseChange::LeftUse);
        assert_eq!(app_use.grace_ends_at(), Some(instant(10 + GRACE_SECONDS)));
        assert!(app_use.in_use_or_in_grace(instant(10 + GRACE_SECONDS - 1)));
        assert!(!app_use.in_use_or_in_grace(instant(10 + GRACE_SECONDS)));

        assert_eq!(app_use.update(true, instant(20)), UseChange::CameIntoUse);
        assert_eq!(app_use.grace_ends_at(), None);
        assert!(app_use.in_use_or_in_grace(instant(10_000)));
    }

    #[test]
    fn a_second_not_in_use_doesn_t_move_the_grace() {
        let mut app_use = AppUse::new();
        app_use.update(true, instant(0));
        app_use.update(false, instant(10));
        assert_eq!(app_use.update(false, instant(50)), UseChange::Unchanged);
        assert_eq!(app_use.grace_ends_at(), Some(instant(10 + GRACE_SECONDS)));
    }

    proptest! {
        /// After the app leaves use, it counts as in use exactly for the grace
        /// period, however long after leaving it is judged.
        #[test]
        fn the_grace_lasts_exactly_its_length(left_at in -1_000_i64..1_000, judged_after in 0_i64..1_000) {
            let mut app_use = AppUse::new();
            app_use.update(true, instant(left_at - 1));
            app_use.update(false, instant(left_at));
            prop_assert_eq!(
                app_use.in_use_or_in_grace(instant(left_at + judged_after)),
                judged_after < GRACE_SECONDS
            );
        }
    }
}
