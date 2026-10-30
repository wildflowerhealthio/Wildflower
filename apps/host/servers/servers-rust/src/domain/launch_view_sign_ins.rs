//! [`LaunchViewSignIns`]: the sign-in codes of each server's launch views,
//! from each view's open until the server's last open launch view closes, so
//! the Owner sessions they signed in end together then. On iOS and Android
//! the views of one server share a cookie jar: a later view's sign-in
//! replaces the cookie an earlier view holds, so ending a closed view's
//! session at its close could leave a view still open holding a dead cookie.
//! The host keeps it across the server's runs, so a run's start keeps the
//! sessions of the views still open.

use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;

use parking_lot::Mutex;

/// The sign-in codes `C` of each server's launch views, by the server's
/// domain, with the views open. Cloning is cheap; every clone is the same
/// set.
#[derive(Debug)]
pub struct LaunchViewSignIns<C> {
    by_server: Arc<Mutex<HashMap<String, ServerSignIns<C>>>>,
}

impl<C> Clone for LaunchViewSignIns<C> {
    fn clone(&self) -> Self {
        Self {
            by_server: Arc::clone(&self.by_server),
        }
    }
}

impl<C> Default for LaunchViewSignIns<C> {
    fn default() -> Self {
        Self {
            by_server: Arc::default(),
        }
    }
}

/// One server's launch views and the sign-in codes they were opened with.
#[derive(Debug)]
struct ServerSignIns<C> {
    /// The views open, by name.
    open_views: BTreeSet<String>,
    /// The codes of the views opened since the server's views last all
    /// closed, the closed ones' included.
    sign_in_codes: Vec<C>,
    /// The codes whose sessions couldn't be ended at an earlier last close.
    pending_end: Vec<C>,
}

impl<C> Default for ServerSignIns<C> {
    fn default() -> Self {
        Self {
            open_views: BTreeSet::new(),
            sign_in_codes: Vec::new(),
            pending_end: Vec::new(),
        }
    }
}

impl<C: Clone> LaunchViewSignIns<C> {
    /// The launch view `view` opened on the server `domain`, with
    /// `sign_in_code`.
    pub fn view_opened(&self, domain: &str, view: &str, sign_in_code: C) {
        let mut by_server = self.by_server.lock();
        let server = by_server.entry(domain.to_owned()).or_default();
        server.open_views.insert(view.to_owned());
        server.sign_in_codes.push(sign_in_code);
    }

    /// The launch view `view` on the server `domain` closed, or failed to
    /// open. Once it was the server's last open view, returns every code the
    /// server's views were opened with since they last all closed, and those
    /// whose sessions couldn't be ended before, for their sessions to be
    /// ended now, and forgets them; otherwise nothing.
    #[must_use]
    pub fn view_closed(&self, domain: &str, view: &str) -> Vec<C> {
        let mut by_server = self.by_server.lock();
        let Some(server) = by_server.get_mut(domain) else {
            return Vec::new();
        };
        server.open_views.remove(view);
        if !server.open_views.is_empty() {
            return Vec::new();
        }
        by_server
            .remove(domain)
            .map(|server| {
                let mut sign_in_codes = server.pending_end;
                sign_in_codes.extend(server.sign_in_codes);
                sign_in_codes
            })
            .unwrap_or_default()
    }

    /// The sessions `sign_in_codes`, which [`view_closed`](Self::view_closed)
    /// returned for the server `domain`, couldn't be ended: keep the codes
    /// apart from the open views', so they are returned again once the
    /// server's next open view closes, and a run's start doesn't keep their
    /// sessions, but ends them.
    pub fn not_ended(&self, domain: &str, sign_in_codes: Vec<C>) {
        self.by_server
            .lock()
            .entry(domain.to_owned())
            .or_default()
            .pending_end
            .extend(sign_in_codes);
    }

    /// The codes whose sessions a run of the server `domain` keeps as it
    /// starts, while it ends every other same-device session: while one of
    /// its launch views is open, every code its views were opened with since
    /// they last all closed, the closed views' included, since any of their
    /// sessions may be the cookie an open view holds, but not those whose
    /// sessions couldn't be ended at an earlier last close. With none open,
    /// nothing, and the server's codes are forgotten, since the start ends
    /// their sessions.
    #[must_use]
    pub fn kept_at_run_start(&self, domain: &str) -> Vec<C> {
        let mut by_server = self.by_server.lock();
        match by_server.get(domain) {
            Some(server) if !server.open_views.is_empty() => server.sign_in_codes.clone(),
            Some(_) => {
                by_server.remove(domain);
                Vec::new()
            }
            None => Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    use super::*;

    const DOMAIN: &str = "ruth.relay.example.com";
    const OTHER_DOMAIN: &str = "sam.relay.example.com";

    /// Closing a view while another of its server's views is open ends
    /// nothing; closing the last one ends every code since, and the codes
    /// are gone after.
    #[test]
    fn the_last_close_ends_every_view_s_code() {
        let sign_ins = LaunchViewSignIns::default();
        sign_ins.view_opened(DOMAIN, "launch-1", "code-1");
        sign_ins.view_opened(DOMAIN, "launch-2", "code-2");
        assert_eq!(sign_ins.view_closed(DOMAIN, "launch-2"), Vec::<&str>::new());
        assert_eq!(
            sign_ins.view_closed(DOMAIN, "launch-1"),
            ["code-1", "code-2"]
        );
        assert_eq!(sign_ins.view_closed(DOMAIN, "launch-1"), Vec::<&str>::new());
    }

    /// Each server's views end on their own.
    #[test]
    fn servers_end_apart() {
        let sign_ins = LaunchViewSignIns::default();
        sign_ins.view_opened(DOMAIN, "launch-1", "code-1");
        sign_ins.view_opened(OTHER_DOMAIN, "launch-2", "code-2");
        assert_eq!(sign_ins.view_closed(DOMAIN, "launch-1"), ["code-1"]);
        assert_eq!(sign_ins.kept_at_run_start(OTHER_DOMAIN), ["code-2"]);
    }

    /// A run's start keeps every code since while a view is open, the
    /// closed views' included, and nothing once none is, forgetting them.
    #[test]
    fn a_run_start_keeps_the_codes_while_a_view_is_open() {
        let sign_ins = LaunchViewSignIns::default();
        sign_ins.view_opened(DOMAIN, "launch-1", "code-1");
        sign_ins.view_opened(DOMAIN, "launch-2", "code-2");
        assert_eq!(sign_ins.view_closed(DOMAIN, "launch-1"), Vec::<&str>::new());
        assert_eq!(sign_ins.kept_at_run_start(DOMAIN), ["code-1", "code-2"]);

        let ended = sign_ins.view_closed(DOMAIN, "launch-2");
        sign_ins.not_ended(DOMAIN, ended);
        assert_eq!(sign_ins.kept_at_run_start(DOMAIN), Vec::<&str>::new());
        sign_ins.view_opened(DOMAIN, "launch-3", "code-3");
        assert_eq!(sign_ins.view_closed(DOMAIN, "launch-3"), ["code-3"]);
    }

    /// Codes whose sessions couldn't be ended aren't kept by a run's start
    /// while a later view is open: the start ends their sessions.
    #[test]
    fn a_run_start_keeps_no_code_not_ended() {
        let sign_ins = LaunchViewSignIns::default();
        sign_ins.view_opened(DOMAIN, "launch-1", "code-1");
        let ended = sign_ins.view_closed(DOMAIN, "launch-1");
        sign_ins.not_ended(DOMAIN, ended);
        sign_ins.view_opened(DOMAIN, "launch-2", "code-2");
        assert_eq!(sign_ins.kept_at_run_start(DOMAIN), ["code-2"]);
    }

    /// Codes whose sessions couldn't be ended come back with the server's
    /// next last close.
    #[test]
    fn codes_not_ended_end_with_the_next_last_close() {
        let sign_ins = LaunchViewSignIns::default();
        sign_ins.view_opened(DOMAIN, "launch-1", "code-1");
        let ended = sign_ins.view_closed(DOMAIN, "launch-1");
        sign_ins.not_ended(DOMAIN, ended);
        sign_ins.view_opened(DOMAIN, "launch-2", "code-2");
        assert_eq!(
            sign_ins.view_closed(DOMAIN, "launch-2"),
            ["code-1", "code-2"]
        );
    }

    proptest! {
        /// However views open and close, each code is returned by exactly
        /// one close, the one that leaves its server with no view open, and
        /// a run's start keeps codes only while a view is open.
        #[test]
        fn each_code_ends_once_with_its_server_s_last_close(
            events in prop::collection::vec((any::<bool>(), 0..4_usize, 0..2_usize), 0..40),
        ) {
            let domains = [DOMAIN, OTHER_DOMAIN];
            let sign_ins = LaunchViewSignIns::default();
            let mut open: Vec<BTreeSet<String>> = vec![BTreeSet::new(); 2];
            let mut opened = 0_usize;
            let mut ended = Vec::new();
            for (opens, view, server) in events {
                let view = format!("launch-{server}-{view}");
                if opens && !open[server].contains(&view) {
                    opened += 1;
                    sign_ins.view_opened(domains[server], &view, opened);
                    open[server].insert(view);
                } else {
                    let was_last = open[server].remove(&view) && open[server].is_empty();
                    let returned = sign_ins.view_closed(domains[server], &view);
                    prop_assert!(was_last || returned.is_empty());
                    ended.extend(returned);
                }
                for (server, domain) in domains.into_iter().enumerate() {
                    if open[server].is_empty() {
                        prop_assert!(sign_ins.kept_at_run_start(domain).is_empty());
                    }
                }
            }
            let mut still_held: Vec<usize> = domains
                .into_iter()
                .flat_map(|domain| sign_ins.kept_at_run_start(domain))
                .collect();
            still_held.extend(ended);
            still_held.sort_unstable();
            prop_assert_eq!(still_held, (1..=opened).collect::<Vec<_>>());
        }
    }
}
