//! `tunnel_settings` singleton-row queries.

use rusqlite::{params, OptionalExtension};

use crate::db::TunnelStore;
use crate::domain::TunnelSettings;
use persistence_rust::DbResult;

/// The settings table only ever holds one row, addressed by this id.
const TUNNEL_SETTINGS_ID: &str = "tunnel";

/// A patch over the API-controllable settings fields. `None` preserves the
/// field, `Some(None)` clears it, `Some(Some(v))` sets it; `requested_running`
/// has no clear (absent preserves, present sets). Relay connection fields are
/// not patched here (no UI yet).
#[derive(Debug, Default)]
pub struct SettingsPatch {
    pub subdomain: Option<Option<String>>,
    pub root_domain: Option<Option<String>>,
    pub requested_running: Option<bool>,
}

impl TunnelStore {
    /// Read the settings row, returning defaults on a fresh install.
    ///
    /// # Errors
    ///
    /// Returns any rusqlite error from the read.
    pub fn get_settings(&self) -> DbResult<TunnelSettings> {
        read_settings(&self.conn().lock())
    }

    /// Apply `patch` to the settings row (creating it if absent) and return the
    /// resulting settings. Read-modify-write under a single lock so the
    /// singleton row can't race.
    ///
    /// # Errors
    ///
    /// Returns any rusqlite error from the read or the upsert.
    pub fn patch_settings(&self, patch: SettingsPatch) -> DbResult<TunnelSettings> {
        let conn = self.conn().lock();
        let mut next = read_settings(&conn)?;
        if let Some(subdomain) = patch.subdomain {
            next.subdomain = subdomain;
        }
        if let Some(root_domain) = patch.root_domain {
            next.root_domain = root_domain;
        }
        if let Some(requested_running) = patch.requested_running {
            next.requested_running = requested_running;
        }
        conn.execute(
            "INSERT INTO tunnel_settings \
             (id, subdomain, root_domain, requested_running, relay_remote_addr, relay_token, relay_public_key, service_name) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) \
             ON CONFLICT(id) DO UPDATE SET \
               subdomain = excluded.subdomain, \
               root_domain = excluded.root_domain, \
               requested_running = excluded.requested_running",
            params![
                TUNNEL_SETTINGS_ID,
                next.subdomain,
                next.root_domain,
                next.requested_running,
                next.relay_remote_addr,
                next.relay_token,
                next.relay_public_key,
                next.service_name,
            ],
        )?;
        Ok(next)
    }
}

fn read_settings(conn: &rusqlite::Connection) -> DbResult<TunnelSettings> {
    conn.query_row(
        "SELECT subdomain, root_domain, requested_running, relay_remote_addr, \
                relay_token, relay_public_key, service_name \
         FROM tunnel_settings WHERE id = ?1",
        [TUNNEL_SETTINGS_ID],
        |row| {
            Ok(TunnelSettings {
                subdomain: row.get(0)?,
                root_domain: row.get(1)?,
                requested_running: row.get(2)?,
                relay_remote_addr: row.get(3)?,
                relay_token: row.get(4)?,
                relay_public_key: row.get(5)?,
                service_name: row.get(6)?,
            })
        },
    )
    .optional()
    .map(Option::unwrap_or_default)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> TunnelStore {
        TunnelStore::open_in_memory().expect("open in-memory store")
    }

    #[test]
    fn defaults_on_fresh_install() {
        let settings = store().get_settings().unwrap();
        assert_eq!(settings, TunnelSettings::default());
    }

    #[test]
    fn patch_sets_preserves_and_clears_and_persists() {
        let store = store();
        // set
        let s = store
            .patch_settings(SettingsPatch {
                subdomain: Some(Some("dev1".into())),
                requested_running: Some(true),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(s.subdomain.as_deref(), Some("dev1"));
        assert!(s.requested_running);

        // preserve subdomain (omitted), set root_domain
        let s = store
            .patch_settings(SettingsPatch {
                root_domain: Some(Some("example.com".into())),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(s.subdomain.as_deref(), Some("dev1"));
        assert_eq!(s.root_domain.as_deref(), Some("example.com"));
        assert!(s.requested_running, "requested_running preserved");

        // clear subdomain
        let s = store
            .patch_settings(SettingsPatch {
                subdomain: Some(None),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(s.subdomain, None);
        assert_eq!(s.root_domain.as_deref(), Some("example.com"));

        // reload from a fresh handle to prove persistence
        assert_eq!(
            store.get_settings().unwrap().root_domain.as_deref(),
            Some("example.com")
        );
    }
}
