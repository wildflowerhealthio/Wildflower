//! `tunnel_settings` singleton-row queries.
//!
//! The row is seeded by the migration (id = `'tunnel'`), so reads always find
//! it and writes are a plain `UPDATE` guarded on `revision` — an atomic
//! compare-and-swap, no upsert and no read-modify-write. The row mapping reads
//! columns by name (not position) so the column list can't silently drift.

use rusqlite::{named_params, Row};

use crate::db::TunnelStore;
use crate::domain::{RelayConnection, TunnelSettings};
use persistence_rust::DbResult;

/// The settings table only ever holds one row, addressed by this id.
const TUNNEL_SETTINGS_ID: &str = "tunnel";

/// The full column list, shared by every read.
const COLS: &str = "revision, public_host, requested_running, \
                    relay_remote_addr, relay_token, relay_public_key, service_name";

impl TryFrom<&Row<'_>> for TunnelSettings {
    type Error = rusqlite::Error;
    fn try_from(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(TunnelSettings {
            revision: row.get("revision")?,
            public_host: row.get("public_host")?,
            requested_running: row.get("requested_running")?,
            relay_remote_addr: row.get("relay_remote_addr")?,
            relay_token: row.get("relay_token")?,
            relay_public_key: row.get("relay_public_key")?,
            service_name: row.get("service_name")?,
        })
    }
}

/// A full replacement of the settings' visible fields, plus an optional
/// write-only relay block: `relay: None` keeps the stored relay connection,
/// `relay: Some(_)` replaces all four relay fields together.
#[derive(Debug, Clone)]
pub struct SettingsUpdate {
    pub public_host: Option<String>,
    pub requested_running: bool,
    pub relay: Option<RelayConnection>,
}

/// The result of a compare-and-swap write: `Applied` when the expected revision
/// matched (carrying the new row), `Conflict` when it didn't (carrying the
/// current row so the caller can re-read and retry).
#[derive(Debug)]
pub enum ReplaceOutcome {
    Applied(TunnelSettings),
    Conflict(TunnelSettings),
}

impl TunnelStore {
    /// Read the singleton settings row.
    ///
    /// # Errors
    ///
    /// Returns any rusqlite error from the read.
    pub fn get_settings(&self) -> DbResult<TunnelSettings> {
        read_settings(&self.conn().lock())
    }

    /// Replace the settings iff `expected_revision` still matches the stored
    /// revision, bumping the revision on success. The visible fields are fully
    /// replaced; the relay block is replaced only when `update.relay` is set
    /// (otherwise the stored relay connection is kept). Returns
    /// [`ReplaceOutcome::Conflict`] (with the current row) when the revision
    /// has moved on.
    ///
    /// # Errors
    ///
    /// Returns any rusqlite error from the update or the read-back.
    pub fn replace_settings(
        &self,
        expected_revision: i64,
        update: SettingsUpdate,
    ) -> DbResult<ReplaceOutcome> {
        let conn = self.conn().lock();
        let affected = match &update.relay {
            Some(relay) => conn.execute(
                "UPDATE tunnel_settings SET \
                    public_host = :public_host, \
                    requested_running = :requested_running, \
                    relay_remote_addr = :relay_remote_addr, \
                    relay_token = :relay_token, \
                    relay_public_key = :relay_public_key, \
                    service_name = :service_name, \
                    revision = revision + 1 \
                 WHERE id = :id AND revision = :expected",
                named_params! {
                    ":public_host": update.public_host,
                    ":requested_running": update.requested_running,
                    ":relay_remote_addr": relay.remote_addr,
                    ":relay_token": relay.token,
                    ":relay_public_key": relay.public_key,
                    ":service_name": relay.service_name,
                    ":id": TUNNEL_SETTINGS_ID,
                    ":expected": expected_revision,
                },
            )?,
            None => conn.execute(
                "UPDATE tunnel_settings SET \
                    public_host = :public_host, \
                    requested_running = :requested_running, \
                    revision = revision + 1 \
                 WHERE id = :id AND revision = :expected",
                named_params! {
                    ":public_host": update.public_host,
                    ":requested_running": update.requested_running,
                    ":id": TUNNEL_SETTINGS_ID,
                    ":expected": expected_revision,
                },
            )?,
        };
        let current = read_settings(&conn)?;
        Ok(if affected == 1 {
            ReplaceOutcome::Applied(current)
        } else {
            ReplaceOutcome::Conflict(current)
        })
    }
}

fn read_settings(conn: &rusqlite::Connection) -> DbResult<TunnelSettings> {
    conn.query_row(
        &format!("SELECT {COLS} FROM tunnel_settings WHERE id = ?1"),
        [TUNNEL_SETTINGS_ID],
        |row| TunnelSettings::try_from(row),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> TunnelStore {
        TunnelStore::open_in_memory().expect("open in-memory store")
    }

    fn update(public_host: Option<&str>, requested_running: bool) -> SettingsUpdate {
        SettingsUpdate {
            public_host: public_host.map(str::to_owned),
            requested_running,
            relay: None,
        }
    }

    fn relay() -> RelayConnection {
        RelayConnection {
            remote_addr: "relay.example.com:2333".into(),
            token: "tok".into(),
            public_key: "key".into(),
            service_name: "dev1".into(),
        }
    }

    #[test]
    fn fresh_install_is_revision_zero_and_empty() {
        let s = store().get_settings().unwrap();
        assert_eq!(s.revision, 0);
        assert_eq!(s.public_host, None);
        assert!(!s.requested_running);
        assert_eq!(s.relay_connection(), None);
    }

    #[test]
    fn replace_applies_on_matching_revision_and_bumps_it() {
        let store = store();
        let outcome = store
            .replace_settings(0, update(Some("dev1.example.com"), true))
            .unwrap();
        let ReplaceOutcome::Applied(s) = outcome else {
            panic!("expected Applied, got {outcome:?}");
        };
        assert_eq!(s.revision, 1);
        assert_eq!(s.public_host.as_deref(), Some("dev1.example.com"));
        assert!(s.requested_running);
        // persists across a fresh read
        assert_eq!(store.get_settings().unwrap().revision, 1);
    }

    #[test]
    fn replace_conflicts_on_stale_revision_and_leaves_state_untouched() {
        let store = store();
        store
            .replace_settings(0, update(Some("dev1"), true))
            .unwrap();
        // a second writer still holding revision 0 loses
        let outcome = store
            .replace_settings(0, update(Some("evil"), false))
            .unwrap();
        let ReplaceOutcome::Conflict(s) = outcome else {
            panic!("expected Conflict, got {outcome:?}");
        };
        assert_eq!(s.revision, 1, "current row returned");
        assert_eq!(s.public_host.as_deref(), Some("dev1"), "unchanged");
        assert!(s.requested_running, "unchanged");
    }

    #[test]
    fn relay_block_is_set_when_present_and_kept_when_absent() {
        let store = store();
        // set the relay block
        store
            .replace_settings(
                0,
                SettingsUpdate {
                    public_host: Some("dev1.example.com".into()),
                    requested_running: false,
                    relay: Some(relay()),
                },
            )
            .unwrap();
        assert_eq!(
            store.get_settings().unwrap().relay_connection(),
            Some(relay())
        );

        // a later write that omits relay keeps it
        store
            .replace_settings(1, update(Some("dev2.example.com"), true))
            .unwrap();
        let s = store.get_settings().unwrap();
        assert_eq!(s.public_host.as_deref(), Some("dev2.example.com"));
        assert_eq!(s.relay_connection(), Some(relay()), "relay kept");
    }
}
