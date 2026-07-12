//! `tunnel_settings` singleton-row queries — the `SQLite` adapter bodies behind
//! `SqliteTunnelStore`'s [`TunnelStore`](crate::domain::TunnelStore) impl.
//!
//! The row is seeded by the migration (id = `'tunnel'`), so reads always find
//! it and writes are a plain `UPDATE` guarded on `revision` — an atomic
//! compare-and-swap, no upsert and no read-modify-write. The row is loaded into
//! a [`TunnelSettingsRow`] via diesel and folded into the domain
//! [`TunnelSettings`] ([`relay_from_columns`] collapses blank/partial relay
//! columns to "unconfigured").

use diesel::prelude::*;
use diesel::sqlite::SqliteConnection;
use persistence_rust::DieselPool;

use crate::db::schema::tunnel_settings;
use crate::domain::{
    RelaySettings, SettingsUpdate, SettingsUpdateOutcome, TunnelError, TunnelSettings,
};

/// The settings table only ever holds one row, addressed by this id.
pub(super) const TUNNEL_SETTINGS_ID: &str = "tunnel";

/// The `tunnel_settings` row as diesel loads it — the mutable column shape,
/// before it's folded into the domain [`TunnelSettings`] (which nests the relay
/// block). The `id` column is omitted: it's the constant singleton key, never
/// read, and `Selectable` selects exactly the listed columns.
/// `revision`/`requested_running` map the SQLite `INTEGER` columns to
/// `i64`/`bool`; the `relay_*` columns are nullable text.
#[derive(Debug, Queryable, Selectable)]
#[diesel(table_name = tunnel_settings)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub(super) struct TunnelSettingsRow {
    pub(super) revision: i64,
    pub(super) public_host: Option<String>,
    pub(super) requested_running: bool,
    pub(super) relay_remote_addr: Option<String>,
    pub(super) relay_token: Option<String>,
    pub(super) relay_public_key: Option<String>,
    pub(super) service_name: Option<String>,
}

/// `Some(owned)` only for a present, non-empty string — treats `Some("")` like
/// `None` so a blanked-out setting counts as unconfigured.
fn as_none_if_empty(value: Option<String>) -> Option<String> {
    value.filter(|s| !s.is_empty())
}

/// Fold the four relay columns into a [`RelaySettings`], or `None` when the
/// relay is unconfigured. Configuration is all-or-nothing: every field must be
/// present and non-empty. A *partial* set (some present, some blank) is a
/// corrupt/legacy shape the API can't produce — logged and treated as
/// unconfigured rather than surfaced, matching the pre-diesel row mapping.
fn relay_from_columns(
    remote_addr: Option<String>,
    token: Option<String>,
    public_key: Option<String>,
    service_name: Option<String>,
) -> Option<RelaySettings> {
    match (
        as_none_if_empty(remote_addr),
        as_none_if_empty(token),
        as_none_if_empty(public_key),
        as_none_if_empty(service_name),
    ) {
        (Some(remote_addr), Some(token), Some(public_key), Some(service_name)) => {
            Some(RelaySettings {
                remote_addr,
                token,
                public_key,
                service_name,
            })
        }
        (None, None, None, None) => None,
        (maybe_remote_addr, maybe_token, maybe_public_key, maybe_service_name) => {
            tracing::warn!(
                "incomplete relay settings in db: \
                 remote_addr={:?} token={:?} public_key={:?} service_name={:?}",
                maybe_remote_addr,
                maybe_token,
                maybe_public_key,
                maybe_service_name
            );
            None
        }
    }
}

impl From<TunnelSettingsRow> for TunnelSettings {
    fn from(row: TunnelSettingsRow) -> Self {
        TunnelSettings {
            revision: row.revision,
            // `public_host` passes through as stored (a blank string is
            // normalized to `None` only at the seed/consume points that care —
            // see `seed_if_absent` and `TunnelControl::current_public_host`).
            public_host: row.public_host,
            requested_running: row.requested_running,
            relay_settings: relay_from_columns(
                row.relay_remote_addr,
                row.relay_token,
                row.relay_public_key,
                row.service_name,
            ),
        }
    }
}

/// Read the singleton settings row over a connection checked out of `pool`.
/// Backs [`SqliteTunnelStore::get_settings`](crate::db::SqliteTunnelStore).
///
/// # Errors
///
/// [`TunnelError::Infrastructure`] on a checkout / read failure.
pub(super) fn get_settings(pool: &DieselPool) -> Result<TunnelSettings, TunnelError> {
    let mut conn = pool
        .get()
        .map_err(|e| TunnelError::infrastructure("failed to check out a connection", e))?;
    read_settings(&mut conn)
}

/// Replace the settings iff `expected_revision` still matches the stored
/// revision, bumping the revision on success. The visible fields are fully
/// replaced; the relay block is replaced only when `update.relay_settings` is
/// set (otherwise the stored relay connection is kept). Returns
/// [`SettingsUpdateOutcome::Conflict`] (with the current row) when the revision
/// has moved on. Backs
/// [`SqliteTunnelStore::replace_settings`](crate::db::SqliteTunnelStore).
///
/// The two arms below differ only in whether they touch the relay columns:
/// relay-present replaces all four, relay-absent omits them entirely so SQLite
/// leaves their stored values in place. Any future *visible* column must be
/// added to BOTH arms (the pre-diesel single `COALESCE` statement folded them;
/// diesel's typed `.set()` can't express per-column COALESCE, so it needs the
/// split).
///
/// # Errors
///
/// [`TunnelError::Infrastructure`] on a checkout / update / read-back failure.
pub(super) fn replace_settings(
    pool: &DieselPool,
    expected_revision: i64,
    update: SettingsUpdate,
) -> Result<SettingsUpdateOutcome, TunnelError> {
    let mut conn = pool
        .get()
        .map_err(|e| TunnelError::infrastructure("failed to check out a connection", e))?;

    // Both arms target the same CAS-guarded singleton row and bump `revision`;
    // they differ ONLY in whether they name the four `relay_*` columns.
    let affected = match update.relay_settings.as_ref() {
        // Relay present: replace all four relay columns alongside the visible
        // fields.
        Some(relay) => diesel::update(
            tunnel_settings::table
                .find(TUNNEL_SETTINGS_ID)
                .filter(tunnel_settings::revision.eq(expected_revision)),
        )
        .set((
            tunnel_settings::public_host.eq(update.public_host.as_deref()),
            tunnel_settings::requested_running.eq(update.requested_running),
            tunnel_settings::relay_remote_addr.eq(Some(relay.remote_addr.as_str())),
            tunnel_settings::relay_token.eq(Some(relay.token.as_str())),
            tunnel_settings::relay_public_key.eq(Some(relay.public_key.as_str())),
            tunnel_settings::service_name.eq(Some(relay.service_name.as_str())),
            tunnel_settings::revision.eq(tunnel_settings::revision + 1),
        ))
        .execute(&mut conn),
        // Relay absent (`relay_settings: None` — the write-only block was
        // omitted, so the stored connection must be kept). This `.set()` tuple
        // deliberately lists ONLY the visible columns + `revision` and OMITS the
        // four `relay_*` columns: a column the UPDATE never names keeps its
        // stored value. That per-column "keep" is exactly what diesel's typed
        // `.set()` can't express as a COALESCE, so it lives in its own arm rather
        // than a shared tuple.
        None => diesel::update(
            tunnel_settings::table
                .find(TUNNEL_SETTINGS_ID)
                .filter(tunnel_settings::revision.eq(expected_revision)),
        )
        .set((
            tunnel_settings::public_host.eq(update.public_host.as_deref()),
            tunnel_settings::requested_running.eq(update.requested_running),
            tunnel_settings::revision.eq(tunnel_settings::revision + 1),
        ))
        .execute(&mut conn),
    }
    .map_err(|e| TunnelError::infrastructure("replace_settings failed", e))?;

    let current = read_settings(&mut conn)?;
    Ok(if affected == 1 {
        SettingsUpdateOutcome::Applied(current)
    } else {
        SettingsUpdateOutcome::Conflict(current)
    })
}

/// Load the singleton row and fold it into the domain [`TunnelSettings`]. Shared
/// by [`get_settings`], the [`replace_settings`] read-back, and the seed path.
/// The row always exists (the migration seeds it), so a missing row is a genuine
/// infrastructure error, not an expected empty result.
pub(super) fn read_settings(conn: &mut SqliteConnection) -> Result<TunnelSettings, TunnelError> {
    tunnel_settings::table
        .find(TUNNEL_SETTINGS_ID)
        .select(TunnelSettingsRow::as_select())
        .first(conn)
        .map(TunnelSettings::from)
        .map_err(|e| TunnelError::infrastructure("read tunnel settings failed", e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::SqliteTunnelStore;
    use crate::domain::TunnelStore;

    fn store() -> SqliteTunnelStore {
        SqliteTunnelStore::open_in_memory().expect("open in-memory store")
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

    /// An explicit `publicHost: null` clears a configured host — the write binds
    /// SQL NULL rather than skipping the column.
    #[test]
    fn replace_with_none_public_host_clears_it() {
        let store = store();
        store
            .replace_settings(0, update(Some("dev1.example.com"), true))
            .unwrap();
        store.replace_settings(1, update(None, true)).unwrap();
        assert_eq!(store.get_settings().unwrap().public_host, None);
    }

    /// Relay configuration is all-or-nothing: a partial column set (here a
    /// missing `service_name`) reads as unconfigured, and a complete set folds
    /// into a `RelaySettings`. Exercises [`relay_from_columns`] directly so the
    /// partial/blank shapes the `replace_settings` API can't produce are covered.
    #[test]
    fn relay_from_columns_needs_every_field_present() {
        assert_eq!(
            relay_from_columns(
                Some("relay:2333".into()),
                Some("tok".into()),
                Some("key".into()),
                None,
            ),
            None,
            "missing service_name",
        );
        let full = relay_from_columns(
            Some("relay:2333".into()),
            Some("tok".into()),
            Some("key".into()),
            Some("dev1".into()),
        )
        .expect("complete columns");
        assert_eq!(full.service_name, "dev1");
    }

    #[test]
    fn blank_relay_columns_count_as_unconfigured() {
        assert_eq!(
            relay_from_columns(
                Some(String::new()),
                Some("tok".into()),
                Some("key".into()),
                Some("dev1".into()),
            ),
            None,
        );
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
