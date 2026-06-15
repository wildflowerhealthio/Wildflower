//! `tunnel_settings` singleton-row queries.
//!
//! The row is seeded by the migration (id = `'tunnel'`), so reads always find
//! it and writes are a plain `UPDATE` guarded on `revision` — an atomic
//! compare-and-swap, no upsert and no read-modify-write. The row mapping reads
//! columns by name (not position) so the column list can't silently drift.

use rusqlite::{named_params, Row};

use crate::db::TunnelStore;
use crate::domain::{RelaySettings, TunnelSettings};
use persistence_rust::DbResult;

/// The settings table only ever holds one row, addressed by this id.
const TUNNEL_SETTINGS_ID: &str = "tunnel";

/// The full column list, shared by every read.
const COLS: &str = "revision, public_host, requested_running, \
                    relay_remote_addr, relay_token, relay_public_key, service_name";

/// `Some(owned)` only for a present, non-empty string — treats `Some("")` like
/// `None` so a blanked-out setting counts as unconfigured.
fn as_none_if_empty(value: Option<String>) -> Option<String> {
    value.filter(|s| !s.is_empty())
}

impl TryFrom<&Row<'_>> for RelaySettings {
    /// Wrap the row-mapping error in an Option to distinguish an actual SQL error from
    /// the expected "no relay settings" case, when not all relay columns are present.
    type Error = Option<rusqlite::Error>;

    fn try_from(row: &Row<'_>) -> Result<Self, Self::Error> {
        let maybe_remote_addr = as_none_if_empty(row.get("relay_remote_addr")?);
        let maybe_token = as_none_if_empty(row.get("relay_token")?);
        let maybe_public_key = as_none_if_empty(row.get("relay_public_key")?);
        let maybe_service_name = as_none_if_empty(row.get("service_name")?);

        match (
            maybe_remote_addr,
            maybe_token,
            maybe_public_key,
            maybe_service_name,
        ) {
            (Some(remote_addr), Some(token), Some(public_key), Some(service_name)) => {
                Ok(RelaySettings {
                    remote_addr,
                    token,
                    public_key,
                    service_name,
                })
            }
            (None, None, None, None) => Err(None),
            (maybe_remote_addr, maybe_token, maybe_public_key, maybe_service_name) => {
                tracing::warn!(
                    "incomplete relay settings in db: \
                     remote_addr={:?} token={:?} public_key={:?} service_name={:?}",
                    maybe_remote_addr,
                    maybe_token,
                    maybe_public_key,
                    maybe_service_name
                );
                Err(None)
            }
        }
    }
}

impl TryFrom<&Row<'_>> for TunnelSettings {
    type Error = rusqlite::Error;
    fn try_from(row: &Row<'_>) -> rusqlite::Result<Self> {
        let relay_settings = match RelaySettings::try_from(row) {
            Ok(relay_settings) => Some(relay_settings),
            // No complete relay settings configured, not an error.
            Err(None) => None,
            // A true error, surface it.
            Err(Some(e)) => return Err(e),
        };
        Ok(TunnelSettings {
            revision: row.get("revision")?,
            public_host: row.get("public_host")?,
            requested_running: row.get("requested_running")?,
            relay_settings,
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
    pub relay_settings: Option<RelaySettings>,
}

/// The result of a compare-and-swap write: `Applied` when the expected revision
/// matched (carrying the new row), `Conflict` when it didn't (carrying the
/// current row so the caller can re-read and retry).
#[derive(Debug)]
pub enum SettingsUpdateOutcome {
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
        read_settings_with_connection(&self.conn().lock())
    }

    /// Replace the settings iff `expected_revision` still matches the stored
    /// revision, bumping the revision on success. The visible fields are fully
    /// replaced; the relay block is replaced only when `update.relay_settings` is set
    /// (otherwise the stored relay connection is kept). Returns
    /// [`SettingsUpdateOutcome::Conflict`] (with the current row) when the revision
    /// has moved on.
    ///
    /// # Errors
    ///
    /// Returns any rusqlite error from the update or the read-back.
    pub fn replace_settings(
        &self,
        expected_revision: i64,
        update: SettingsUpdate,
    ) -> DbResult<SettingsUpdateOutcome> {
        let conn = self.conn().lock();
        let affected = match &update.relay_settings {
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
        let current = read_settings_with_connection(&conn)?;
        Ok(if affected == 1 {
            SettingsUpdateOutcome::Applied(current)
        } else {
            SettingsUpdateOutcome::Conflict(current)
        })
    }
}

fn read_settings_with_connection(conn: &rusqlite::Connection) -> DbResult<TunnelSettings> {
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
            relay_settings: None,
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

    #[test]
    fn fresh_install_is_revision_zero_and_empty() {
        let s = store().get_settings().unwrap();
        assert_eq!(s.revision, 0);
        assert_eq!(s.public_host, None);
        assert!(!s.requested_running);
        assert_eq!(s.relay_settings, None);
    }

    #[test]
    fn replace_applies_on_matching_revision_and_bumps_it() {
        let store = store();
        let outcome = store
            .replace_settings(0, update(Some("dev1.example.com"), true))
            .unwrap();
        let SettingsUpdateOutcome::Applied(s) = outcome else {
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
        let SettingsUpdateOutcome::Conflict(s) = outcome else {
            panic!("expected Conflict, got {outcome:?}");
        };
        assert_eq!(s.revision, 1, "current row returned");
        assert_eq!(s.public_host.as_deref(), Some("dev1"), "unchanged");
        assert!(s.requested_running, "unchanged");
    }

    /// Synthesize a single-row result-set with the four relay columns named the
    /// way `RelaySettings::try_from` reads them, and run the mapping against it.
    /// Sidesteps the migrated store so we can poke at partial/blank shapes the
    /// `replace_settings` API can't produce.
    fn try_relay_settings_from_row_content(
        remote_addr: Option<&str>,
        token: Option<&str>,
        public_key: Option<&str>,
        service_name: Option<&str>,
    ) -> Result<RelaySettings, Option<rusqlite::Error>> {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT \
                    ?1 AS relay_remote_addr, \
                    ?2 AS relay_token, \
                    ?3 AS relay_public_key, \
                    ?4 AS service_name",
            )
            .unwrap();
        let mut rows = stmt
            .query(rusqlite::params![
                remote_addr,
                token,
                public_key,
                service_name
            ])
            .unwrap();
        let row = rows.next().unwrap().expect("one row");
        RelaySettings::try_from(row)
    }

    #[test]
    fn relay_settings_is_none_until_all_columns_present() {
        assert!(
            matches!(
                try_relay_settings_from_row_content(
                    Some("relay:2333"),
                    Some("tok"),
                    Some("key"),
                    None
                ),
                Err(None),
            ),
            "missing service_name"
        );
        let full = try_relay_settings_from_row_content(
            Some("relay:2333"),
            Some("tok"),
            Some("key"),
            Some("dev1"),
        )
        .expect("complete row");
        assert_eq!(full.service_name, "dev1");
    }

    #[test]
    fn blank_relay_columns_count_as_unconfigured() {
        assert!(matches!(
            try_relay_settings_from_row_content(Some(""), Some("tok"), Some("key"), Some("dev1")),
            Err(None),
        ));
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
                    relay_settings: Some(relay()),
                },
            )
            .unwrap();
        assert_eq!(store.get_settings().unwrap().relay_settings, Some(relay()));

        // a later write that omits relay keeps it
        store
            .replace_settings(1, update(Some("dev2.example.com"), true))
            .unwrap();
        let s = store.get_settings().unwrap();
        assert_eq!(s.public_host.as_deref(), Some("dev2.example.com"));
        assert_eq!(s.relay_settings, Some(relay()), "relay kept");
    }
}
