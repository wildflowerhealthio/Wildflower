//! Domain actions over the [`TunnelStore`] port — the seam the HTTP routes (and
//! the control seam) call instead of touching a concrete store. Each function
//! takes `&impl TunnelStore`, so it runs against the `SQLite` adapter in
//! production and against an in-memory fake in tests, with no database or HTTP
//! layer in the way.
//!
//! For tunnel these are thin relays to the port: the settings surface carries no
//! domain logic beyond the store's own compare-and-swap. They exist for the test
//! seam and to keep the routes uniform with collector, whose actions do hold
//! inner logic. Any genuine settings-level logic added later lands here, not in a
//! route handler.

use crate::domain::{
    SettingsSeed, SettingsUpdate, SettingsUpdateOutcome, TunnelError, TunnelSettings, TunnelStore,
};

/// Read the current persisted settings.
///
/// # Errors
///
/// [`TunnelError::Infrastructure`] if the store read fails.
pub fn get_settings(store: &impl TunnelStore) -> Result<TunnelSettings, TunnelError> {
    store.get_settings()
}

/// Compare-and-swap the settings under `expected_revision` (see
/// [`TunnelStore::replace_settings`] for the relay-keep semantics).
///
/// # Errors
///
/// [`TunnelError::Infrastructure`] if the store write fails.
pub fn replace_settings(
    store: &impl TunnelStore,
    expected_revision: i64,
    update: SettingsUpdate,
) -> Result<SettingsUpdateOutcome, TunnelError> {
    store.replace_settings(expected_revision, update)
}

/// Seed build-time defaults into any unconfigured fields (see
/// [`TunnelStore::seed_if_absent`]).
///
/// # Errors
///
/// [`TunnelError::Infrastructure`] if the store write fails.
pub fn seed_if_absent(store: &impl TunnelStore, seed: &SettingsSeed) -> Result<(), TunnelError> {
    store.seed_if_absent(seed)
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;
    use crate::domain::RelaySettings;

    /// An in-memory [`TunnelStore`] modelling the real compare-and-swap and
    /// seed-if-absent semantics — no diesel, no database. Lets the actions be
    /// exercised directly; the `SQLite` adapter's own coverage lives in
    /// `crate::db`.
    #[derive(Default)]
    struct FakeTunnelStore {
        settings: RefCell<TunnelSettings>,
    }

    impl TunnelStore for FakeTunnelStore {
        fn get_settings(&self) -> Result<TunnelSettings, TunnelError> {
            Ok(self.settings.borrow().clone())
        }

        fn replace_settings(
            &self,
            expected_revision: i64,
            update: SettingsUpdate,
        ) -> Result<SettingsUpdateOutcome, TunnelError> {
            let mut current = self.settings.borrow_mut();
            if current.revision != expected_revision {
                return Ok(SettingsUpdateOutcome::Conflict(current.clone()));
            }
            *current = TunnelSettings {
                revision: current.revision + 1,
                public_host: update.public_host,
                requested_running: update.requested_running,
                // `None` keeps the stored relay connection, mirroring the adapter.
                relay_settings: update
                    .relay_settings
                    .or_else(|| current.relay_settings.clone()),
            };
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

    #[test]
    fn get_settings_relays_the_stored_snapshot() {
        let store = FakeTunnelStore::default();
        let s = get_settings(&store).expect("read");
        assert_eq!(s.revision, 0);
        assert_eq!(s.public_host, None);
        assert!(!s.requested_running);
    }

    #[test]
    fn replace_applies_on_matching_revision_and_bumps_it() {
        let store = FakeTunnelStore::default();
        let outcome =
            replace_settings(&store, 0, update(Some("dev1.example.com"), true)).expect("write");
        let SettingsUpdateOutcome::Applied(s) = outcome else {
            panic!("expected Applied, got {outcome:?}");
        };
        assert_eq!(s.revision, 1);
        assert_eq!(s.public_host.as_deref(), Some("dev1.example.com"));
        assert!(s.requested_running);
        assert_eq!(get_settings(&store).unwrap().revision, 1, "persisted");
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

    #[test]
    fn replace_keeps_the_stored_relay_when_the_update_omits_it() {
        let store = FakeTunnelStore::default();
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
        // A later write that omits the relay keeps the stored connection.
        replace_settings(&store, 1, update(Some("dev2.example.com"), true)).unwrap();
        let s = get_settings(&store).unwrap();
        assert_eq!(s.public_host.as_deref(), Some("dev2.example.com"));
        assert_eq!(s.relay_settings, Some(relay()), "relay kept");
    }

    #[test]
    fn seed_fills_absent_fields_without_bumping_revision() {
        let store = FakeTunnelStore::default();
        seed_if_absent(
            &store,
            &SettingsSeed {
                public_host: Some("seed.example.com".into()),
                relay: Some(relay()),
            },
        )
        .unwrap();
        let s = get_settings(&store).unwrap();
        assert_eq!(s.revision, 0, "seeding is initialization, not a write");
        assert_eq!(s.public_host.as_deref(), Some("seed.example.com"));
        assert_eq!(s.relay_settings, Some(relay()));
    }

    #[test]
    fn seed_never_clobbers_a_configured_value() {
        let store = FakeTunnelStore::default();
        replace_settings(
            &store,
            0,
            SettingsUpdate {
                public_host: Some("user.example.com".into()),
                requested_running: false,
                relay_settings: Some(relay()),
            },
        )
        .unwrap();
        seed_if_absent(
            &store,
            &SettingsSeed {
                public_host: Some("seed.example.com".into()),
                relay: Some(RelaySettings {
                    remote_addr: "other:1".into(),
                    token: "other".into(),
                    public_key: "other".into(),
                    service_name: "other".into(),
                }),
            },
        )
        .unwrap();
        let s = get_settings(&store).unwrap();
        assert_eq!(s.public_host.as_deref(), Some("user.example.com"), "kept");
        assert_eq!(s.relay_settings, Some(relay()), "kept");
        assert_eq!(s.revision, 1, "seed didn't bump revision");
    }
}
