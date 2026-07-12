//! Build-time seeding for the `tunnel_settings` singleton row — the `SQLite`
//! adapter body behind `SqliteTunnelStore`'s
//! [`seed_if_absent`](crate::domain::TunnelStore::seed_if_absent).
//!
//! Split from `tunnel_settings` (the runtime read/replace queries): seeding is a
//! startup-only concern that fills *unconfigured* fields from baked-in defaults
//! without bumping `revision`, so a fresh install picks up the relay connection
//! while an in-app edit is never overwritten. The [`SettingsSeed`] param type is
//! a pure domain type ([`crate::domain::SettingsSeed`]).

use diesel::prelude::*;
use persistence_rust::DieselPool;

use super::tunnel_settings::{read_settings, TUNNEL_SETTINGS_ID};
use crate::db::schema::tunnel_settings;
use crate::domain::{SettingsSeed, TunnelError};

/// Fill `public_host` and/or the relay block from build-time defaults, but only
/// where the stored value is currently unconfigured — an in-app edit is never
/// clobbered. Does **not** bump `revision` (this is initialization, not a user
/// write). A no-op once configured, or when the seed is empty. Backs
/// [`SqliteTunnelStore::seed_if_absent`](crate::db::SqliteTunnelStore).
///
/// Runs once at startup before the slice serves, so the read-then-write has no
/// concurrent writer to race. Each field seeds through its own targeted
/// `UPDATE`, so a `None` bind can never overwrite a stored value with NULL (the
/// pre-diesel single `COALESCE` statement kept the stored value on a `None`
/// bind; the split, guarded updates achieve the same).
///
/// # Errors
///
/// [`TunnelError::Infrastructure`] on a checkout / read-back / update failure.
pub(super) fn seed_if_absent(pool: &DieselPool, seed: &SettingsSeed) -> Result<(), TunnelError> {
    let mut conn = pool
        .get()
        .map_err(|e| TunnelError::infrastructure("failed to check out a connection", e))?;

    // The migration always inserts the singleton row and every store migrates
    // before seeding, so the read always finds it.
    let current = read_settings(&mut conn)?;

    // Seed a field only where the stored value is unconfigured; the relay is
    // all-or-nothing, gated on the whole block being unset.
    // `revision`/`requested_running` are intentionally untouched.
    let host_to_seed = current
        .public_host
        .as_ref()
        .is_none_or(String::is_empty)
        .then_some(seed.public_host.as_deref())
        .flatten();
    let relay_to_seed = current
        .relay_settings
        .is_none()
        .then_some(seed.relay.as_ref())
        .flatten();

    if let Some(host) = host_to_seed {
        diesel::update(tunnel_settings::table.find(TUNNEL_SETTINGS_ID))
            .set(tunnel_settings::public_host.eq(Some(host)))
            .execute(&mut conn)
            .map_err(|e| TunnelError::infrastructure("seed public_host failed", e))?;
    }
    if let Some(relay) = relay_to_seed {
        diesel::update(tunnel_settings::table.find(TUNNEL_SETTINGS_ID))
            .set((
                tunnel_settings::relay_remote_addr.eq(Some(relay.remote_addr.as_str())),
                tunnel_settings::relay_token.eq(Some(relay.token.as_str())),
                tunnel_settings::relay_public_key.eq(Some(relay.public_key.as_str())),
                tunnel_settings::service_name.eq(Some(relay.service_name.as_str())),
            ))
            .execute(&mut conn)
            .map_err(|e| TunnelError::infrastructure("seed relay failed", e))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::SqliteTunnelStore;
    use crate::domain::{RelaySettings, SettingsUpdate, TunnelStore};

    fn store() -> SqliteTunnelStore {
        SqliteTunnelStore::open_in_memory().expect("open in-memory store")
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
