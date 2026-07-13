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
use persistence_rust::PooledDieselConnection;

use crate::db::schema::tunnel_settings;
use crate::domain::{RelaySettings, SettingsUpdateOutcome, TunnelError, TunnelSettings};

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
pub(super) fn get_settings(
    conn: &mut PooledDieselConnection,
) -> Result<TunnelSettings, TunnelError> {
    read_settings(conn)
}

/// Compare-and-swap the visible settings (`public_host`, `requested_running`)
/// under `expected_revision`, bumping the revision on success. The four
/// `relay_*` columns are **deliberately not named**, so SQLite leaves them at
/// their stored values — this is the "keep the stored relay connection" write.
/// Backs
/// [`SqliteTunnelStore::update_basic_settings`](crate::db::SqliteTunnelStore).
///
/// The domain [`actions`](crate::domain::actions) picks this over
/// [`update_all_settings`] from the `SettingsUpdate`; the store never branches on
/// the relay's presence. A column the UPDATE never names keeps its stored value
/// — the per-column "keep" diesel's typed `.set()` can't express as a COALESCE.
///
/// # Errors
///
/// [`TunnelError::Infrastructure`] on a checkout / update / read-back failure.
pub(super) fn update_basic_settings(
    conn: &mut PooledDieselConnection,
    expected_revision: i64,
    public_host: Option<&str>,
    requested_running: bool,
) -> Result<SettingsUpdateOutcome, TunnelError> {
    let affected = diesel::update(
        tunnel_settings::table
            .find(TUNNEL_SETTINGS_ID)
            .filter(tunnel_settings::revision.eq(expected_revision)),
    )
    .set((
        tunnel_settings::public_host.eq(public_host),
        tunnel_settings::requested_running.eq(requested_running),
        tunnel_settings::revision.eq(tunnel_settings::revision + 1),
    ))
    .execute(conn)
    .map_err(|e| TunnelError::infrastructure("update_basic_settings failed", e))?;

    outcome_after_cas(conn, affected)
}

/// Compare-and-swap the visible settings **and all four relay columns** under
/// `expected_revision`, bumping the revision on success. Backs
/// [`SqliteTunnelStore::update_all_settings`](crate::db::SqliteTunnelStore).
///
/// Pair to [`update_basic_settings`], which omits the relay columns. Any future
/// *visible* column must be added to both writes.
///
/// # Errors
///
/// [`TunnelError::Infrastructure`] on a checkout / update / read-back failure.
pub(super) fn update_all_settings(
    conn: &mut PooledDieselConnection,
    expected_revision: i64,
    public_host: Option<&str>,
    requested_running: bool,
    relay: &RelaySettings,
) -> Result<SettingsUpdateOutcome, TunnelError> {
    let affected = diesel::update(
        tunnel_settings::table
            .find(TUNNEL_SETTINGS_ID)
            .filter(tunnel_settings::revision.eq(expected_revision)),
    )
    .set((
        tunnel_settings::public_host.eq(public_host),
        tunnel_settings::requested_running.eq(requested_running),
        tunnel_settings::relay_remote_addr.eq(Some(relay.remote_addr.as_str())),
        tunnel_settings::relay_token.eq(Some(relay.token.as_str())),
        tunnel_settings::relay_public_key.eq(Some(relay.public_key.as_str())),
        tunnel_settings::service_name.eq(Some(relay.service_name.as_str())),
        tunnel_settings::revision.eq(tunnel_settings::revision + 1),
    ))
    .execute(conn)
    .map_err(|e| TunnelError::infrastructure("update_all_settings failed", e))?;

    outcome_after_cas(conn, affected)
}

/// Read the current row back over `conn` and fold the CAS's affected-row count
/// into the outcome: exactly one row means the revision matched
/// ([`SettingsUpdateOutcome::Applied`]), zero means it had moved on
/// ([`SettingsUpdateOutcome::Conflict`]). Shared by the two single-purpose
/// writes above so the read-back-and-classify step lives in one place.
fn outcome_after_cas(
    conn: &mut SqliteConnection,
    affected: usize,
) -> Result<SettingsUpdateOutcome, TunnelError> {
    let current = read_settings(conn)?;
    Ok(if affected == 1 {
        SettingsUpdateOutcome::Applied(current)
    } else {
        SettingsUpdateOutcome::Conflict(current)
    })
}

/// Load the singleton row and fold it into the domain [`TunnelSettings`]. Shared
/// by [`get_settings`], the [`update_basic_settings`] / [`update_all_settings`]
/// read-back (via [`outcome_after_cas`]), and the seed path. The row always
/// exists (the migration seeds it), so a missing row is a genuine infrastructure
/// error, not an expected empty result.
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
    fn update_basic_applies_on_matching_revision_and_bumps_it() {
        let store = store();
        let outcome = store
            .update_basic_settings(0, Some("dev1.example.com"), true)
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
    fn update_basic_conflicts_on_stale_revision_and_leaves_state_untouched() {
        let store = store();
        store.update_basic_settings(0, Some("dev1"), true).unwrap();
        // a second writer still holding revision 0 loses
        let outcome = store.update_basic_settings(0, Some("evil"), false).unwrap();
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
    fn update_basic_with_none_public_host_clears_it() {
        let store = store();
        store
            .update_basic_settings(0, Some("dev1.example.com"), true)
            .unwrap();
        store.update_basic_settings(1, None, true).unwrap();
        assert_eq!(store.get_settings().unwrap().public_host, None);
    }

    /// Relay configuration is all-or-nothing: a partial column set (here a
    /// missing `service_name`) reads as unconfigured, and a complete set folds
    /// into a `RelaySettings`. Exercises [`relay_from_columns`] directly so the
    /// partial/blank shapes the write API can't produce are covered.
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
    fn update_all_sets_the_relay_block_and_update_basic_keeps_it() {
        let store = store();
        // `update_all_settings` writes the relay block
        store
            .update_all_settings(0, Some("dev1.example.com"), false, &relay())
            .unwrap();
        assert_eq!(store.get_settings().unwrap().relay_settings, Some(relay()));

        // a later `update_basic_settings` leaves the stored relay columns alone
        store
            .update_basic_settings(1, Some("dev2.example.com"), true)
            .unwrap();
        let s = store.get_settings().unwrap();
        assert_eq!(s.public_host.as_deref(), Some("dev2.example.com"));
        assert_eq!(s.relay_settings, Some(relay()), "relay kept");
    }
}
