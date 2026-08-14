//! The shared `app_registrations` table and the registration-wide query bodies —
//! the ones that read or rewrite the authoritative registration rows across every
//! kind: the uniform catalogue read, the id / position allocators the per-kind
//! inserts consume, and the atomic homescreen placement rewrite (the single writer of
//! `position` / `on_homescreen`).
//!
//! This file owns the [`app_registrations`] `table!` definition (the global id space,
//! the shared catalogue fields, and the placement columns) and the [`AppKindColumn`]
//! mapping for its `kind` discriminator — both also referenced by the domain
//! [`AppRegistration`](crate::domain::AppRegistration)'s diesel derive, so they stay
//! `pub`. The per-kind configuration tables live in their own kind files.

use std::collections::HashSet;

use diesel::prelude::*;
use persistence_rust::PooledDieselConnection;

use super::shared::text_column;
use crate::domain::{is_exact_registry_permutation, AppKind, AppRegistration, AppsError};

diesel::table! {
    app_registrations (id) {
        id -> Text,
        kind -> Text,
        position -> BigInt,
        on_homescreen -> Bool,
        name -> Text,
        subtitle -> Nullable<Text>,
        local_only -> Bool,
        client_id -> Nullable<Text>,
        requires_tunnel -> Bool,
    }
}

text_column!(
    /// An [`AppKind`] bound to / read from the `kind` TEXT column as its kebab string. A
    /// stored value that isn't a known kind surfaces as a diesel deserialization error,
    /// never a panic — matching the table's `CHECK (kind IN (…))` on the write side.
    pub AppKindColumn(AppKind),
    serialize: |kind| kind.as_str(),
);

/// The uniform catalogue read against an arbitrary connection — shared by the
/// [`SqliteAppsStore`](super::SqliteAppsStore) `list_registrations` delegation and
/// the placement transaction (which calls it on its open transaction so the
/// post-renumber read stays in the same transaction). Join-free: the registration
/// carries everything the homescreen tile renders.
pub(super) fn list_registrations_on(
    conn: &mut SqliteConnection,
) -> Result<Vec<AppRegistration>, AppsError> {
    app_registrations::table
        .order(app_registrations::position)
        .select(AppRegistration::as_select())
        .load(conn)
        .map_err(|e| AppsError::infrastructure("list registrations failed", e))
}

/// Whether any app already holds this id — checked against `app_registrations`, the
/// registration PK and so the global id space across every kind. The per-kind inserts
/// call it to reject a colliding id.
pub(super) fn id_taken(conn: &mut SqliteConnection, id: &str) -> Result<bool, AppsError> {
    diesel::select(diesel::dsl::exists(
        app_registrations::table.filter(app_registrations::id.eq(id)),
    ))
    .get_result::<bool>(conn)
    .map_err(|e| AppsError::infrastructure("id-taken check failed", e))
}

/// The next display position: `MAX(position) + 1` (0 for an empty registry). The
/// per-kind inserts append at the tail with it.
pub(super) fn next_position(conn: &mut SqliteConnection) -> Result<i64, AppsError> {
    let max: Option<i64> = app_registrations::table
        .select(diesel::dsl::max(app_registrations::position))
        .first(conn)
        .map_err(|e| AppsError::infrastructure("next-position read failed", e))?;
    Ok(max.map_or(0, |m| m + 1))
}

/// Atomically validate **and** rewrite the whole homescreen placement — the
/// ordering **and** the `on_homescreen` flags — in one transaction over
/// `app_registrations`. The body must list every registry app exactly once; each
/// `(id, on_homescreen)` at index `i` sets that row's `position = i` and
/// `on_homescreen`. Returns the resulting registry in its new order (read inside the
/// same transaction), or `Ok(None)` when `entries` isn't an exact permutation of
/// the live registry — the caller maps that to `400 InvalidHomeScreen`.
///
/// The sole writer of `position` / `on_homescreen` across every kind. See the
/// single-writer section of `docs/Apps/Store and Install Explanation.md`.
///
/// # Errors
///
/// [`AppsError::Infrastructure`] on a checkout / transaction failure.
pub(super) fn replace_placements(
    conn: &mut PooledDieselConnection,
    entries: &[(String, bool)],
) -> Result<Option<Vec<AppRegistration>>, AppsError> {
    // IMMEDIATE so the permutation read and the renumber can't be split by a concurrent
    // add/remove — see the transaction-discipline section of
    // `docs/Apps/Store and Install Explanation.md`.
    conn.immediate_transaction(|conn| {
        // Validate against the live registry under the same transaction as the
        // renumber: the body must be an exact permutation of the current ids. The
        // set logic is a pure domain function; here we only supply the two id sets.
        let current_ids = all_registration_ids(conn)?;
        let body_ids: Vec<&str> = entries.iter().map(|(id, _)| id.as_str()).collect();
        if !is_exact_registry_permutation(&current_ids, &body_ids) {
            return Ok(None);
        }

        // Move every row to a disjoint negative range first so the per-row
        // renumber below never transiently violates `UNIQUE(position)`
        // (SQLite's UNIQUE is immediate, not deferrable).
        diesel::sql_query("UPDATE app_registrations SET position = -1 - position")
            .execute(conn)
            .map_err(|e| AppsError::infrastructure("placement renumber staging failed", e))?;
        for (index, (id, on_homescreen)) in entries.iter().enumerate() {
            // A registry with more than i64::MAX apps can't exist, but map rather
            // than panic so any conversion failure rolls the transaction back.
            let position = i64::try_from(index)
                .map_err(|e| AppsError::infrastructure("home-screen index exceeds i64", e))?;
            diesel::update(app_registrations::table.find(id))
                .set((
                    app_registrations::position.eq(position),
                    app_registrations::on_homescreen.eq(on_homescreen),
                ))
                .execute(conn)
                .map_err(|e| AppsError::infrastructure("placement renumber failed", e))?;
        }

        // Read the new registry inside the transaction so the response can't
        // reflect a write that landed after the renumber.
        let updated = list_registrations_on(conn)?;
        Ok(Some(updated))
    })
}

/// Every registration id (the global app-id space) as a set — the home-screen
/// permutation check's live-registry input, read inside the placement transaction.
fn all_registration_ids(conn: &mut SqliteConnection) -> Result<HashSet<String>, AppsError> {
    Ok(app_registrations::table
        .select(app_registrations::id)
        .load::<String>(conn)
        .map_err(|e| AppsError::infrastructure("registration-ids read failed", e))?
        .into_iter()
        .collect())
}

#[cfg(test)]
mod tests {
    use crate::db::SqliteAppsStore;
    // The port trait is in scope so the concrete adapter's methods resolve.
    use crate::domain::{AppKind, AppsStore};

    /// The migration seeds the full default set: 8 registrations in display order
    /// with the right kind.
    #[test]
    fn migration_seeds_the_default_registry() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        let registrations = store.list_registrations().unwrap();
        let ids: Vec<&str> = registrations.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(
            ids,
            vec![
                "patient-browser",
                "api-view",
                "api-docs",
                "growth-chart",
                "medication-viewer",
                "precise-hbr",
                "medications-app",
                "web-trace-app",
            ],
            "seeded apps must come back in position order",
        );
    }

    /// `list_registrations` reports `is_smart` (cloud SMART-client rows),
    /// `local_only` (the loopback ones), `requires_tunnel` (cloud), and the kind per
    /// row.
    #[test]
    fn list_registrations_reports_the_shared_facts_per_row() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        let registrations = store.list_registrations().unwrap();
        let by_id = |id: &str| {
            registrations
                .iter()
                .find(|r| r.id == id)
                .expect("seeded row")
        };

        for cloud in ["growth-chart", "medication-viewer", "precise-hbr"] {
            let reg = by_id(cloud);
            assert!(reg.is_smart(), "{cloud} must be smart");
            assert_eq!(reg.kind, AppKind::Cloud);
            assert!(reg.requires_tunnel, "{cloud} requires the tunnel");
        }
        for local in ["patient-browser", "api-view", "api-docs"] {
            let reg = by_id(local);
            assert!(reg.local_only, "{local} must be local-only");
            assert!(!reg.is_smart(), "{local} must not be smart");
            assert!(!reg.requires_tunnel, "{local} must not require the tunnel");
        }
        assert_eq!(by_id("patient-browser").kind, AppKind::SelfHosted);
        assert_eq!(by_id("api-view").kind, AppKind::System);
    }

    /// `replace_placements` renumbers every row to its array index and applies
    /// each `on_homescreen` flag, in one shot, for any kind — leaving a dense `0..n`
    /// permutation (no ties).
    #[test]
    fn replace_placements_renumbers_and_sets_on_homescreen_for_any_kind() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        let entries: Vec<(String, bool)> = vec![
            ("precise-hbr".to_owned(), true),
            ("medication-viewer".to_owned(), true),
            ("growth-chart".to_owned(), true),
            ("api-docs".to_owned(), false),
            ("api-view".to_owned(), true),
            ("patient-browser".to_owned(), true),
            ("medications-app".to_owned(), true),
            ("web-trace-app".to_owned(), true),
        ];
        let updated = store
            .replace_placements(&entries)
            .unwrap()
            .expect("an exact permutation renumbers and returns the registry");

        let expected: Vec<String> = entries.iter().map(|(id, _)| id.clone()).collect();
        let returned_ids: Vec<String> = updated.iter().map(|r| r.id.clone()).collect();
        assert_eq!(returned_ids, expected);

        for (position, (id, _)) in entries.iter().enumerate() {
            let (registration, _) = store.find_app(id).unwrap().unwrap();
            assert_eq!(
                registration.position,
                i64::try_from(position).unwrap(),
                "{id} position"
            );
        }
        let (api_docs, _) = store.find_app("api-docs").unwrap().unwrap();
        assert!(!api_docs.on_homescreen);
        let ids: Vec<String> = store
            .list_registrations()
            .unwrap()
            .iter()
            .map(|r| r.id.clone())
            .collect();
        assert_eq!(ids, expected);
    }

    /// A body that isn't an exact permutation of the live registry returns
    /// `Ok(None)` (→ `400`) and writes nothing.
    #[test]
    fn replace_placements_rejects_a_non_permutation_without_writing() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        let ids_now = |store: &SqliteAppsStore| -> Vec<String> {
            store
                .list_registrations()
                .unwrap()
                .iter()
                .map(|r| r.id.clone())
                .collect()
        };
        let before = ids_now(&store);

        let subset = vec![("api-view".to_owned(), true), ("api-docs".to_owned(), true)];
        assert!(store.replace_placements(&subset).unwrap().is_none());

        let dup = vec![
            ("patient-browser".to_owned(), true),
            ("api-view".to_owned(), true),
            ("api-docs".to_owned(), true),
            ("growth-chart".to_owned(), true),
            ("medication-viewer".to_owned(), true),
            ("api-view".to_owned(), true),
        ];
        assert!(store.replace_placements(&dup).unwrap().is_none());

        assert_eq!(
            before,
            ids_now(&store),
            "a rejected body must not reorder anything"
        );
    }
}
