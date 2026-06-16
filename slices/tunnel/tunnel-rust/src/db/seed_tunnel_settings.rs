//! Build-time seeding for the `tunnel_settings` singleton row.
//!
//! Split from `tunnel_settings` (the runtime read/replace queries): seeding is a
//! startup-only concern that fills *unconfigured* fields from baked-in defaults
//! without bumping `revision`, so a fresh install picks up the relay connection
//! while an in-app edit is never overwritten.

use rusqlite::named_params;

use super::tunnel_settings::{read_settings_with_connection, TUNNEL_SETTINGS_ID};
use crate::db::TunnelStore;
use crate::domain::{RelaySettings, TunnelSettings};
use persistence_rust::DbResult;

/// Build-time defaults seeded into the row at startup. Each field fills the
/// stored value only when it's currently unconfigured (see
/// [`TunnelStore::seed_if_absent`]), so a fresh install picks up the baked-in
/// connection while an in-app edit is never overwritten.
#[derive(Debug, Clone, Default)]
pub struct SettingsSeed {
    pub public_host: Option<String>,
    pub relay: Option<RelaySettings>,
}

impl TunnelStore {
    /// Fill `public_host` and/or the relay block from build-time defaults, but
    /// only where the stored value is currently unconfigured — an in-app edit is
    /// never clobbered. Does **not** bump `revision` (this is initialization,
    /// not a user write). A no-op once configured, or when the seed is empty.
    ///
    /// Runs once at startup before the slice serves, so the single shared
    /// connection has no concurrent writer to race.
    ///
    /// # Errors
    ///
    /// Returns any rusqlite error from the read-back or the update.
    pub fn seed_if_absent(&self, seed: &SettingsSeed) -> DbResult<()> {
        let conn = self.conn().lock();
        // Migration 001 always inserts the singleton row and every `TunnelStore`
        // migrates before seeding, so the read always finds it — a missing row
        // is a genuine error, not a fresh namespace to INSERT into.
        let TunnelSettings {
            public_host: current_public_host,
            relay_settings: current_relay_settings,
            ..
        } = read_settings_with_connection(&conn)?;

        // Seed a field only where the stored value is unconfigured; the relay is
        // all-or-nothing, gated on the whole block being unset. A `None` bind
        // makes `COALESCE` keep the stored value, so this is the same single
        // SET list as `replace_settings` — a future column can't be skipped on
        // one path. `revision`/`requested_running` are intentionally untouched.
        let maybe_new_public_host = if current_public_host.as_ref().is_none_or(String::is_empty) {
            seed.public_host.as_deref()
        } else {
            None
        };
        let maybe_new_relay_settings = if current_relay_settings.is_none() {
            seed.relay.as_ref()
        } else {
            None
        };

        if maybe_new_public_host.is_none() && maybe_new_relay_settings.is_none() {
            return Ok(());
        }

        conn.execute(
            "UPDATE tunnel_settings SET \
                public_host = COALESCE(:public_host, public_host), \
                relay_remote_addr = COALESCE(:relay_remote_addr, relay_remote_addr), \
                relay_token = COALESCE(:relay_token, relay_token), \
                relay_public_key = COALESCE(:relay_public_key, relay_public_key), \
                service_name = COALESCE(:service_name, service_name) \
             WHERE id = :id",
            named_params! {
                ":public_host": maybe_new_public_host,
                ":relay_remote_addr": maybe_new_relay_settings.map(|r| &r.remote_addr),
                ":relay_token": maybe_new_relay_settings.map(|r| &r.token),
                ":relay_public_key": maybe_new_relay_settings.map(|r| &r.public_key),
                ":service_name": maybe_new_relay_settings.map(|r| &r.service_name),
                ":id": TUNNEL_SETTINGS_ID,
            },
        )
        .map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::SettingsUpdate;

    fn store() -> TunnelStore {
        TunnelStore::open_in_memory().expect("open in-memory store")
    }

    fn relay() -> RelaySettings {
        RelaySettings {
            remote_addr: "relay.example.com:2333".into(),
            token: "tok".into(),
            public_key: "key".into(),
            service_name: "dev1".into(),
        }
    }

    #[test]
    fn seed_fills_absent_fields_without_bumping_revision() {
        let store = store();
        store
            .seed_if_absent(&SettingsSeed {
                public_host: Some("seed.example.com".into()),
                relay: Some(relay()),
            })
            .unwrap();
        let s = store.get_settings().unwrap();
        assert_eq!(s.revision, 0, "seeding is initialization, not a write");
        assert_eq!(s.public_host.as_deref(), Some("seed.example.com"));
        assert_eq!(s.relay_settings, Some(relay()));
    }

    #[test]
    fn seed_never_clobbers_a_configured_value() {
        let store = store();
        // The user configures via the API (bumps revision to 1).
        store
            .replace_settings(
                0,
                SettingsUpdate {
                    public_host: Some("user.example.com".into()),
                    requested_running: false,
                    relay_settings: Some(relay()),
                },
            )
            .unwrap();
        // A later boot with different baked-in defaults must not overwrite it.
        store
            .seed_if_absent(&SettingsSeed {
                public_host: Some("seed.example.com".into()),
                relay: Some(RelaySettings {
                    remote_addr: "other:1".into(),
                    token: "other".into(),
                    public_key: "other".into(),
                    service_name: "other".into(),
                }),
            })
            .unwrap();
        let s = store.get_settings().unwrap();
        assert_eq!(s.public_host.as_deref(), Some("user.example.com"), "kept");
        assert_eq!(s.relay_settings, Some(relay()), "kept");
        assert_eq!(s.revision, 1, "seed didn't bump revision");
    }
}
