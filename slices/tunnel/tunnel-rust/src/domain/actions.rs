//! The one tunnel domain action over the [`TunnelStore`] port —
//! [`replace_settings`], the seam the HTTP write capability (and the control
//! seam's tests) call instead of touching a concrete store. It takes
//! `&impl TunnelStore`, so it runs against the `SQLite` adapter in production and
//! against an in-memory fake in tests, with no database or HTTP layer in the way.
//!
//! It exists because it holds the one piece of settings-level logic that isn't
//! the store's own compare-and-swap: the relay-present / relay-absent routing
//! (which store method a `PUT /tunnel` body maps to). That choice lives here, in
//! the domain, so both the write capability and the control seam drive the same
//! switch and a fake store can validate the routing without a database. The
//! trivial reads / seeds are one-liners inlined at their call sites (the capability
//! and `setup_tunnel`).

use crate::domain::{SettingsUpdate, SettingsUpdateOutcome, TunnelError, TunnelStore};

/// Compare-and-swap the settings under `expected_revision`, routing to the store
/// method that matches the update's shape: an update **with** a relay block
/// writes every column via [`TunnelStore::update_all_settings`]; one **without**
/// leaves the stored relay connection in place via
/// [`TunnelStore::update_basic_settings`].
///
/// This relay-present / relay-absent choice lives here, in the domain, rather
/// than inside the store — so a fake store can validate the routing without a
/// database (the store's two methods each do a single unconditional write).
///
/// # Errors
///
/// [`TunnelError::Infrastructure`] if the store write fails.
pub fn replace_settings(
    store: &impl TunnelStore,
    expected_revision: i64,
    update: SettingsUpdate,
) -> Result<SettingsUpdateOutcome, TunnelError> {
    match update.relay_settings.as_ref() {
        Some(relay) => store.update_all_settings(
            expected_revision,
            update.public_host.as_deref(),
            update.requested_running,
            relay,
        ),
        None => store.update_basic_settings(
            expected_revision,
            update.public_host.as_deref(),
            update.requested_running,
        ),
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;
    use crate::domain::{RelaySettings, SettingsSeed, TunnelSettings};

    /// Which store method the action routed a `replace_settings` call to, with
    /// the args it forwarded. Recorded by [`FakeTunnelStore`] so a test can
    /// assert the relay-present / relay-absent switch *without* a database — the
    /// whole point of moving that switch into the action.
    #[derive(Debug, Clone, PartialEq, Eq)]
    enum LastCall {
        Basic {
            public_host: Option<String>,
            requested_running: bool,
        },
        All {
            public_host: Option<String>,
            requested_running: bool,
            relay: RelaySettings,
        },
    }

    /// An in-memory [`TunnelStore`] modelling the real compare-and-swap and
    /// seed-if-absent semantics — no diesel, no database. Lets the actions be
    /// exercised directly; the `SQLite` adapter's own coverage lives in
    /// `crate::db`. It also records the [`LastCall`] the action routed to, so a
    /// test can assert the switch as well as its effect.
    #[derive(Default)]
    struct FakeTunnelStore {
        settings: RefCell<TunnelSettings>,
        last_call: RefCell<Option<LastCall>>,
    }

    impl FakeTunnelStore {
        /// The store method the action last routed to (and its args), or `None`
        /// if no write has been routed yet.
        fn last_call(&self) -> Option<LastCall> {
            self.last_call.borrow().clone()
        }
    }

    impl TunnelStore for FakeTunnelStore {
        fn get_settings(&self) -> Result<TunnelSettings, TunnelError> {
            Ok(self.settings.borrow().clone())
        }

        fn update_basic_settings(
            &self,
            expected_revision: i64,
            public_host: Option<&str>,
            requested_running: bool,
        ) -> Result<SettingsUpdateOutcome, TunnelError> {
            self.last_call.replace(Some(LastCall::Basic {
                public_host: public_host.map(str::to_owned),
                requested_running,
            }));
            let mut current = self.settings.borrow_mut();
            if current.revision != expected_revision {
                return Ok(SettingsUpdateOutcome::Conflict(current.clone()));
            }
            current.revision += 1;
            current.public_host = public_host.map(str::to_owned);
            current.requested_running = requested_running;
            // The relay block is deliberately left as stored — the basic write.
            Ok(SettingsUpdateOutcome::Applied(current.clone()))
        }

        fn update_all_settings(
            &self,
            expected_revision: i64,
            public_host: Option<&str>,
            requested_running: bool,
            relay: &RelaySettings,
        ) -> Result<SettingsUpdateOutcome, TunnelError> {
            self.last_call.replace(Some(LastCall::All {
                public_host: public_host.map(str::to_owned),
                requested_running,
                relay: relay.clone(),
            }));
            let mut current = self.settings.borrow_mut();
            if current.revision != expected_revision {
                return Ok(SettingsUpdateOutcome::Conflict(current.clone()));
            }
            current.revision += 1;
            current.public_host = public_host.map(str::to_owned);
            current.requested_running = requested_running;
            current.relay_settings = Some(relay.clone());
            Ok(SettingsUpdateOutcome::Applied(current.clone()))
        }

        fn seed_if_absent(&self, seed: &SettingsSeed) -> Result<(), TunnelError> {
            let mut current = self.settings.borrow_mut();
            if current.public_host.as_ref().is_none_or(String::is_empty) {
                current.public_host = seed.public_host.clone();
            }
            if current.relay_settings.is_none() {
                current.relay_settings = seed.relay.clone();
            }
            // Seeding is initialization, not a write — `revision` is untouched.
            Ok(())
        }
    }

    fn relay() -> RelaySettings {
        RelaySettings {
            remote_addr: "relay.example.com:2333".into(),
            token: "tok".into(),
            public_key: "key".into(),
            service_name: "dev1".into(),
        }
    }

    fn update(public_host: Option<&str>, requested_running: bool) -> SettingsUpdate {
        SettingsUpdate {
            public_host: public_host.map(str::to_owned),
            requested_running,
            relay_settings: None,
        }
    }

    /// An update carrying a relay block routes to `update_all_settings`, which
    /// writes the relay alongside the visible fields. Asserted through the
    /// recorded [`LastCall`] as well as the effect — no database.
    #[test]
    fn replace_with_relay_routes_to_update_all_settings() {
        let store = FakeTunnelStore::default();
        let outcome = replace_settings(
            &store,
            0,
            SettingsUpdate {
                public_host: Some("dev1.example.com".into()),
                requested_running: true,
                relay_settings: Some(relay()),
            },
        )
        .expect("write");
        let SettingsUpdateOutcome::Applied(s) = outcome else {
            panic!("expected Applied, got {outcome:?}");
        };
        assert_eq!(s.revision, 1);
        assert_eq!(s.public_host.as_deref(), Some("dev1.example.com"));
        assert!(s.requested_running);
        assert_eq!(s.relay_settings, Some(relay()), "relay applied");
        assert_eq!(
            store.last_call(),
            Some(LastCall::All {
                public_host: Some("dev1.example.com".into()),
                requested_running: true,
                relay: relay(),
            }),
            "routed to update_all_settings",
        );
    }

    /// An update with no relay block routes to `update_basic_settings`, which
    /// leaves the stored relay connection in place. Again asserted via the
    /// recorded [`LastCall`] and the effect, without SQLite.
    #[test]
    fn replace_without_relay_routes_to_update_basic_settings() {
        let store = FakeTunnelStore::default();
        // Seed a stored relay via a first (relay-carrying) write.
        replace_settings(
            &store,
            0,
            SettingsUpdate {
                public_host: Some("dev1.example.com".into()),
                requested_running: false,
                relay_settings: Some(relay()),
            },
        )
        .unwrap();

        let outcome =
            replace_settings(&store, 1, update(Some("dev2.example.com"), true)).expect("write");
        let SettingsUpdateOutcome::Applied(s) = outcome else {
            panic!("expected Applied, got {outcome:?}");
        };
        assert_eq!(s.public_host.as_deref(), Some("dev2.example.com"));
        assert!(s.requested_running);
        assert_eq!(s.relay_settings, Some(relay()), "stored relay untouched");
        assert_eq!(
            store.last_call(),
            Some(LastCall::Basic {
                public_host: Some("dev2.example.com".into()),
                requested_running: true,
            }),
            "routed to update_basic_settings",
        );
    }

    #[test]
    fn replace_conflicts_on_stale_revision_and_leaves_state_untouched() {
        let store = FakeTunnelStore::default();
        replace_settings(&store, 0, update(Some("dev1"), true)).unwrap();
        let outcome = replace_settings(&store, 0, update(Some("evil"), false)).expect("write");
        let SettingsUpdateOutcome::Conflict(s) = outcome else {
            panic!("expected Conflict, got {outcome:?}");
        };
        assert_eq!(s.revision, 1, "current row returned");
        assert_eq!(s.public_host.as_deref(), Some("dev1"), "unchanged");
        assert!(s.requested_running, "unchanged");
    }
}
