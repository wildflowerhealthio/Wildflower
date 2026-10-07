//! [`AppPresence`]: whether the app is open, and the grace period `WhileOpen`
//! units keep running for after it closes.

use std::time::Duration;

use chrono::{DateTime, TimeDelta, Utc};

/// How long a `WhileOpen` unit keeps running after the app closes, measured on
/// the wall clock. A short trip away from the app (a closed window reopened, a
/// phone briefly locked) doesn't stop it.
pub const WHILE_OPEN_GRACE: Duration = Duration::from_secs(2 * 60);

/// How the app's presence changed with an update.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PresenceChange {
    /// The app was closed and is open now.
    Opened,
    /// The app was open and is closed now; the grace period starts.
    Closed,
    /// No change.
    Unchanged,
}

/// Whether the app is open, and when its current grace period began.
///
/// On a desktop the app is open while any of its windows is, minimized
/// included. On a phone it is open while it is in the foreground. It starts
/// out closed with no grace period, so a `WhileOpen` unit starts once the
/// app's first window opens (desktop) or the app is in the foreground
/// (mobile).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AppPresence {
    open: bool,
    entered_grace_period_at: Option<DateTime<Utc>>,
}

impl AppPresence {
    /// The app closed, with no grace period running.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Record whether the app is open as of the wall-clock instant `now`.
    pub fn update(&mut self, open: bool, now: DateTime<Utc>) -> PresenceChange {
        match (self.open, open) {
            (false, true) => {
                self.open = true;
                self.entered_grace_period_at = None;
                PresenceChange::Opened
            }
            (true, false) => {
                self.open = false;
                self.entered_grace_period_at = Some(now);
                PresenceChange::Closed
            }
            (true, true) | (false, false) => PresenceChange::Unchanged,
        }
    }

    /// Whether the app is open, or closed less than [`WHILE_OPEN_GRACE`]
    /// before the wall-clock instant `now`.
    #[must_use]
    pub fn open_or_in_grace(&self, now: DateTime<Utc>) -> bool {
        self.open || self.grace_ends_at().is_some_and(|ends_at| now < ends_at)
    }

    /// When the current grace period ends, or `None` while the app is open or
    /// before it has ever been.
    #[must_use]
    pub fn grace_ends_at(&self) -> Option<DateTime<Utc>> {
        let grace = TimeDelta::from_std(WHILE_OPEN_GRACE).expect("the grace fits a TimeDelta");
        self.entered_grace_period_at
            .map(|entered_at| entered_at + grace)
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
    fn the_app_starts_out_closed_with_no_grace() {
        let presence = AppPresence::new();
        assert!(!presence.open_or_in_grace(instant(0)));
        assert_eq!(presence.grace_ends_at(), None);
    }

    #[test]
    fn closing_starts_the_grace_and_opening_ends_it() {
        let mut presence = AppPresence::new();
        assert_eq!(presence.update(true, instant(0)), PresenceChange::Opened);
        assert_eq!(presence.update(true, instant(1)), PresenceChange::Unchanged);
        assert_eq!(presence.update(false, instant(10)), PresenceChange::Closed);
        assert_eq!(presence.grace_ends_at(), Some(instant(10 + GRACE_SECONDS)));
        assert!(presence.open_or_in_grace(instant(10 + GRACE_SECONDS - 1)));
        assert!(!presence.open_or_in_grace(instant(10 + GRACE_SECONDS)));

        assert_eq!(presence.update(true, instant(20)), PresenceChange::Opened);
        assert_eq!(presence.grace_ends_at(), None);
        assert!(presence.open_or_in_grace(instant(10_000)));
    }

    #[test]
    fn a_second_close_doesn_t_move_the_grace() {
        let mut presence = AppPresence::new();
        presence.update(true, instant(0));
        presence.update(false, instant(10));
        assert_eq!(
            presence.update(false, instant(50)),
            PresenceChange::Unchanged
        );
        assert_eq!(presence.grace_ends_at(), Some(instant(10 + GRACE_SECONDS)));
    }

    proptest! {
        /// After the app closes, it counts as open for exactly the grace
        /// period, however long after closing it is judged.
        #[test]
        fn the_grace_lasts_exactly_its_length(closed_at in -1_000_i64..1_000, judged_after in 0_i64..1_000) {
            let mut presence = AppPresence::new();
            presence.update(true, instant(closed_at - 1));
            presence.update(false, instant(closed_at));
            prop_assert_eq!(
                presence.open_or_in_grace(instant(closed_at + judged_after)),
                judged_after < GRACE_SECONDS
            );
        }
    }
}
