//! [`LastSeenThrottle`] — the in-memory gate in front of the conditional
//! update that moves a browser session's `last_seen_at` when its cookie is
//! used. A page load sends many requests on one cookie; the throttle lets
//! through at most one per [`LAST_SEEN_RESOLUTION`] per session, so the rest
//! write nothing. The update's own guard holds the same limit across a
//! restart, which empties the throttle.

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use parking_lot::Mutex;

use crate::domain::browser_session::LAST_SEEN_RESOLUTION;

/// When each recently used browser session's cookie use was last let through,
/// by `sid`.
pub(crate) struct LastSeenThrottle {
    admitted_at_by_sid: Mutex<HashMap<String, DateTime<Utc>>>,
}

impl LastSeenThrottle {
    /// No session let through yet.
    pub(crate) fn new() -> Self {
        LastSeenThrottle {
            admitted_at_by_sid: Mutex::new(HashMap::new()),
        }
    }

    /// Whether a use of session `sid` at `now` goes on to the update: none was
    /// let through in the [`LAST_SEEN_RESOLUTION`] before `now`. One that goes
    /// on is noted at `now`, and every note older than the window is dropped,
    /// so the map holds only the sessions let through within the last window:
    /// at most the live sessions, since a `sid` reaches here only from a token
    /// the gates accepted.
    pub(crate) fn admit(&self, sid: &str, now: DateTime<Utc>) -> bool {
        let window_start = now - LAST_SEEN_RESOLUTION;
        let mut admitted_at_by_sid = self.admitted_at_by_sid.lock();
        if admitted_at_by_sid
            .get(sid)
            .is_some_and(|admitted_at| *admitted_at > window_start)
        {
            return false;
        }
        admitted_at_by_sid.retain(|_, admitted_at| *admitted_at > window_start);
        admitted_at_by_sid.insert(sid.to_owned(), now);
        true
    }

    /// Drop session `sid`'s note, so its next use goes on: the update the use
    /// let through failed.
    pub(crate) fn forget(&self, sid: &str) {
        self.admitted_at_by_sid.lock().remove(sid);
    }

    /// How many sessions the throttle holds a note for.
    #[cfg(test)]
    fn noted_sessions(&self) -> usize {
        self.admitted_at_by_sid.lock().len()
    }
}

#[cfg(test)]
mod tests {
    use chrono::Duration;

    use super::*;

    /// A session's first use goes on; the next inside the window doesn't, and
    /// the first once the window has passed does. Each session has its own
    /// window.
    #[test]
    fn one_use_per_session_per_window_goes_on() {
        let throttle = LastSeenThrottle::new();
        let now = Utc::now();
        assert!(throttle.admit("a", now));
        assert!(!throttle.admit("a", now + Duration::minutes(4)));
        assert!(
            throttle.admit("b", now + Duration::minutes(4)),
            "its own window"
        );
        assert!(throttle.admit("a", now + LAST_SEEN_RESOLUTION));
        assert!(!throttle.admit("a", now + LAST_SEEN_RESOLUTION + Duration::seconds(1)));
    }

    /// Letting a use through drops every note older than the window, so the
    /// map holds only the sessions used within it.
    #[test]
    fn the_map_holds_only_the_last_window_s_sessions() {
        let throttle = LastSeenThrottle::new();
        let now = Utc::now();
        for sid in ["a", "b", "c"] {
            assert!(throttle.admit(sid, now));
        }
        assert_eq!(throttle.noted_sessions(), 3);
        assert!(throttle.admit("d", now + Duration::minutes(6)));
        assert_eq!(throttle.noted_sessions(), 1);
    }

    /// A forgotten session's next use goes on inside the window.
    #[test]
    fn a_forgotten_session_goes_on_again() {
        let throttle = LastSeenThrottle::new();
        let now = Utc::now();
        assert!(throttle.admit("a", now));
        throttle.forget("a");
        assert!(throttle.admit("a", now + Duration::minutes(1)));
    }
}
