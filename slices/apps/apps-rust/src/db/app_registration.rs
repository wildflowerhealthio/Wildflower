//! The `app_registrations` table and the query bodies over it: the catalogue
//! read, the by-id read, the insert / content replace / delete mutators, and the
//! atomic homescreen placement rewrite (the single writer of `position` /
//! `on_homescreen`).
//!
//! This file owns the [`app_registrations`] `table!` definition and the
//! [`AppUrlColumn`] mapping for its `url` column — both also referenced by the
//! domain [`AppRegistration`](crate::domain::AppRegistration)'s diesel derive, so
//! they stay `pub`. Insert and replace hand back the stored registration via
//! `RETURNING` on the writing statement — no separate read-back — which also
//! re-decodes the stored `url`, so a value that no longer round-trips surfaces as a
//! typed error.

use std::collections::HashSet;

use diesel::prelude::*;
use persistence_rust::PooledDieselConnection;

use super::shared::text_column;
use crate::domain::{
    is_exact_registry_permutation, AppInsertError, AppRegistration, AppUrl, AppsError,
};

diesel::table! {
    app_registrations (id) {
        id -> Text,
        position -> BigInt,
        on_homescreen -> Bool,
        name -> Text,
        subtitle -> Nullable<Text>,
        url -> Text,
        client_id -> Nullable<Text>,
        requires_tunnel -> Bool,
    }
}

text_column!(
    /// An [`AppUrl`] bound to / read from the `url` TEXT column as its canonical
    /// string. A stored value that no longer parses surfaces as a diesel
    /// deserialization error, never a panic or an unsafe redirect target.
    pub AppUrlColumn(AppUrl),
    serialize: |url| url.to_string(),
);

/// The catalogue read against an arbitrary connection — shared by the
/// [`SqliteAppsStore`](super::SqliteAppsStore) `list_registrations` delegation and
/// the placement transaction (which calls it on its open transaction so the
/// post-renumber read stays in the same transaction).
pub(super) fn list_registrations_on(
    conn: &mut SqliteConnection,
) -> Result<Vec<AppRegistration>, AppsError> {
    app_registrations::table
        .order(app_registrations::position)
        .select(AppRegistration::as_select())
        .load(conn)
        .map_err(|e| AppsError::infrastructure("list registrations failed", e))
}

/// One app by id, or `Ok(None)` when no registration has this id.
pub(super) fn find_app(
    conn: &mut SqliteConnection,
    id: &str,
) -> Result<Option<AppRegistration>, AppsError> {
    app_registrations::table
        .find(id)
        .select(AppRegistration::as_select())
        .first(conn)
        .optional()
        .map_err(|e| AppsError::infrastructure("find app failed", e))
}

/// Whether any app already holds this id — the registration PK, so ids are unique
/// across every app. [`insert_app`] calls it to reject a colliding id.
fn id_taken(conn: &mut SqliteConnection, id: &str) -> Result<bool, AppsError> {
    diesel::select(diesel::dsl::exists(
        app_registrations::table.filter(app_registrations::id.eq(id)),
    ))
    .get_result::<bool>(conn)
    .map_err(|e| AppsError::infrastructure("id-taken check failed", e))
}

/// The next display position: `MAX(position) + 1` (0 for an empty registry).
/// [`insert_app`] appends at the tail with it.
fn next_position(conn: &mut SqliteConnection) -> Result<i64, AppsError> {
    let max: Option<i64> = app_registrations::table
        .select(diesel::dsl::max(app_registrations::position))
        .first(conn)
        .map_err(|e| AppsError::infrastructure("next-position read failed", e))?;
    Ok(max.map_or(0, |m| m + 1))
}

/// Insert a fresh app from a caller-built `registration`. The store owns the
/// display `position` (assigned at the tail, overriding whatever the caller
/// passed); every other field is used as given.
///
/// Returns `Ok(Err(AppInsertError::IdTaken))` when the id is already taken (no row
/// is written), else the inserted registration, hydrated from the insert's
/// `RETURNING`.
///
/// # Errors
///
/// [`AppsError::Infrastructure`] on a checkout / transaction failure.
pub(super) fn insert_app(
    conn: &mut PooledDieselConnection,
    registration: &AppRegistration,
) -> Result<Result<AppRegistration, AppInsertError>, AppsError> {
    // IMMEDIATE so the `next_position` read + insert can't race a concurrent create —
    // see the transaction-discipline section of `docs/Apps/Store Explanation.md`.
    conn.immediate_transaction(|conn| {
        if id_taken(conn, &registration.id)? {
            return Ok(Err(AppInsertError::IdTaken));
        }
        // The store owns `position` (tail append); everything else is the caller's.
        let stored: AppRegistration = diesel::insert_into(app_registrations::table)
            .values(AppRegistration {
                position: next_position(conn)?,
                ..registration.clone()
            })
            .returning(AppRegistration::as_returning())
            .get_result(conn)
            .map_err(|e| AppsError::infrastructure("app insert failed", e))?;
        Ok(Ok(stored))
    })
}

/// Replace an app's editable fields from a caller-built `registration`, located by
/// `registration.id`: `name` / `subtitle` / `url` / `requires_tunnel`. **Never
/// touches `on_homescreen` / position** (the placement single-writer) or the other
/// columns.
///
/// Returns `Ok(None)` when no app has this id, else the updated registration,
/// hydrated from the update's `RETURNING`.
///
/// # Errors
///
/// [`AppsError::Infrastructure`] on a checkout / statement failure.
pub(super) fn replace_app(
    conn: &mut SqliteConnection,
    registration: &AppRegistration,
) -> Result<Option<AppRegistration>, AppsError> {
    diesel::update(app_registrations::table.find(&registration.id))
        .set((
            app_registrations::name.eq(&registration.name),
            app_registrations::subtitle.eq(&registration.subtitle),
            app_registrations::url.eq(AppUrlColumn::from(registration.url.clone())),
            app_registrations::requires_tunnel.eq(registration.requires_tunnel),
        ))
        .returning(AppRegistration::as_returning())
        .get_result(conn)
        .optional()
        .map_err(|e| AppsError::infrastructure("app update failed", e))
}

/// Delete an app by id. Returns whether a row was removed (i.e. the app existed).
///
/// # Errors
///
/// [`AppsError::Infrastructure`] on a checkout / statement failure.
pub(super) fn delete_app(conn: &mut SqliteConnection, id: &str) -> Result<bool, AppsError> {
    let removed = diesel::delete(app_registrations::table.find(id))
        .execute(conn)
        .map_err(|e| AppsError::infrastructure("delete app failed", e))?;
    Ok(removed == 1)
}

/// Atomically validate **and** rewrite the whole homescreen placement — the
/// ordering **and** the `on_homescreen` flags — in one transaction over
/// `app_registrations`. The body must list every registry app exactly once; each
/// `(id, on_homescreen)` at index `i` sets that row's `position = i` and
/// `on_homescreen`. Returns the resulting registry in its new order (read inside the
/// same transaction), or `Ok(None)` when `entries` isn't an exact permutation of
/// the live registry — the caller maps that to `400 InvalidHomeScreen`.
///
/// The sole writer of `position` / `on_homescreen`. See the
/// single-writer section of `docs/Apps/Store Explanation.md`.
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
    // `docs/Apps/Store Explanation.md`.
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
    use diesel::prelude::*;

    use super::super::test_support::{error_text, external, registration};
    use crate::db::SqliteAppsStore;
    // The port trait is in scope so the concrete adapter's methods resolve.
    use crate::domain::{AppInsertError, AppUrl, AppsStore};

    /// The seeded registry, in display order.
    const SEEDED_IDS: [&str; 9] = [
        "growth-chart",
        "medication-viewer",
        "precise-hbr",
        "medications-app",
        "web-trace-app",
        "web-server-docs",
        "importer-app",
        "ohif-viewer",
        "lifting-app",
    ];

    /// The migrations seed the full default set in display order.
    #[test]
    fn migration_seeds_the_default_registry() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        let registrations = store.list_registrations().unwrap();
        let ids: Vec<&str> = registrations.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(
            ids, SEEDED_IDS,
            "seeded apps must come back in position order"
        );
    }

    /// `list_registrations` reports `is_smart`, `requires_tunnel`, and the launch
    /// template per row.
    #[test]
    fn list_registrations_reports_the_facts_per_row() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        let registrations = store.list_registrations().unwrap();
        for id in ["growth-chart", "medication-viewer", "precise-hbr"] {
            let reg = registrations
                .iter()
                .find(|r| r.id == id)
                .expect("seeded row");
            assert!(reg.is_smart(), "{id} must be smart");
            assert!(reg.requires_tunnel, "{id} requires the tunnel");
            assert!(
                reg.url.to_string().contains("{launch}"),
                "{id} carries its launch template",
            );
        }
    }

    /// `find_app` reads the whole app; an unknown id is `None`.
    #[test]
    fn find_app_reads_the_whole_app() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        let registration = store.find_app("growth-chart").unwrap().expect("seeded");
        assert_eq!(registration.name, "Growth Chart");
        assert!(registration.is_smart());
        assert!(registration.requires_tunnel);
        assert!(registration.url.to_string().contains("growth-chart-app"));
        assert!(store.find_app("no-such-id").unwrap().is_none());
    }

    /// A stored `url` that no longer parses surfaces as a typed read error (the
    /// `AppUrlColumn` deserialize), not a silent unsafe value. A `javascript:`
    /// scheme is one such rejected shape (an XSS redirect target).
    #[test]
    fn find_app_rejects_an_unparseable_stored_url() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        let mut conn = store.pool().get().unwrap();
        diesel::sql_query(
            "UPDATE app_registrations SET url = 'javascript:alert(1)' WHERE id = 'growth-chart'",
        )
        .execute(&mut conn)
        .unwrap();
        drop(conn);
        let error = store
            .find_app("growth-chart")
            .expect_err("an unparseable url must fail the read");
        assert!(
            error_text(&error).contains("find app failed"),
            "error should name the read: {error:?}",
        );
    }

    #[test]
    fn insert_app_returns_the_stored_registration_and_round_trips() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        let inserted = store
            .insert_app(&registration(
                "app-x",
                external("https://example.com/launch"),
            ))
            .unwrap()
            .expect("inserted");
        assert_eq!(store.find_app("app-x").unwrap(), Some(inserted.clone()));
        assert_eq!(inserted.position, 9, "the store assigns the tail position");
        assert!(inserted.on_homescreen);
        assert!(!inserted.is_smart(), "inserted app has no client_id");
        assert_eq!(inserted.url, external("https://example.com/launch"));
        assert!(!inserted.requires_tunnel);
    }

    #[test]
    fn insert_app_reports_id_taken_on_duplicate_id() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        let app = registration("app-x", external("https://example.com/x"));
        assert!(store.insert_app(&app).unwrap().is_ok());
        assert_eq!(
            store.insert_app(&app).unwrap(),
            Err(AppInsertError::IdTaken),
            "second insert with the same id is a no-op",
        );
        assert_eq!(store.find_app("app-x").unwrap().unwrap().position, 9);
    }

    /// A seeded app's id can't be re-created — `app_registrations` already holds it,
    /// so the insert is a no-op `IdTaken` and the original row is untouched.
    #[test]
    fn insert_app_rejects_a_seeded_id() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        assert_eq!(
            store
                .insert_app(&registration(
                    "growth-chart",
                    external("https://example.com/x")
                ))
                .unwrap(),
            Err(AppInsertError::IdTaken),
        );
        let stored = store.find_app("growth-chart").unwrap().unwrap();
        assert!(stored.url.to_string().contains("growth-chart-app"));
    }

    #[test]
    fn replace_app_writes_the_editable_fields() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        store
            .insert_app(&registration("app-x", external("https://example.com/x")))
            .unwrap()
            .expect("inserted");

        let mut edited = registration("app-x", AppUrl::OriginRelative("/path".to_owned()));
        edited.name = "Renamed".to_owned();
        edited.subtitle = Some("the new subtitle".to_owned());
        edited.requires_tunnel = true;
        let replaced = store.replace_app(&edited).unwrap().expect("replaced");
        assert_eq!(replaced.name, "Renamed");
        assert_eq!(replaced.subtitle.as_deref(), Some("the new subtitle"));
        assert!(replaced.requires_tunnel);
        assert_eq!(replaced.url, AppUrl::OriginRelative("/path".to_owned()));
        assert_eq!(store.find_app("app-x").unwrap(), Some(replaced));
    }

    /// A content replace must not touch `on_homescreen` — `PUT /home-screen` is that
    /// flag's single writer — even though the caller-built registration carries the
    /// `on_homescreen = true` default.
    #[test]
    fn replace_app_leaves_on_homescreen_alone() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        store
            .insert_app(&registration("app-x", external("https://example.com/x")))
            .unwrap()
            .expect("inserted");

        let entries: Vec<(String, bool)> = store
            .list_registrations()
            .unwrap()
            .iter()
            .map(|reg| (reg.id.clone(), reg.id != "app-x"))
            .collect();
        store
            .replace_placements(&entries)
            .unwrap()
            .expect("permutation");
        assert!(!store.find_app("app-x").unwrap().unwrap().on_homescreen);

        let mut edited = registration("app-x", external("https://example.com/y"));
        edited.name = "Renamed".to_owned();
        let replaced = store.replace_app(&edited).unwrap().expect("replaced");
        assert!(
            !replaced.on_homescreen,
            "a content replace must not re-show a hidden app",
        );
    }

    #[test]
    fn replace_app_returns_none_for_unknown_id() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        assert!(store
            .replace_app(&registration("ghost", external("https://x.example")))
            .unwrap()
            .is_none());
    }

    /// Delete removes the row, for a user-created and a seeded app alike.
    #[test]
    fn delete_app_removes_the_registration() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        store
            .insert_app(&registration(
                "my-app",
                external("https://example.com/launch"),
            ))
            .unwrap()
            .expect("inserted");
        assert!(store.delete_app("my-app").unwrap());
        assert!(store.find_app("my-app").unwrap().is_none());
        assert!(
            !store.delete_app("my-app").unwrap(),
            "a second delete of the same id removes nothing",
        );

        assert!(store.delete_app("growth-chart").unwrap());
        assert!(store.find_app("growth-chart").unwrap().is_none());
        assert!(!store.delete_app("no-such-id").unwrap());
    }

    /// `replace_placements` renumbers every row to its array index and applies
    /// each `on_homescreen` flag, in one shot — leaving a dense `0..n` permutation
    /// (no ties).
    #[test]
    fn replace_placements_renumbers_and_sets_on_homescreen() {
        let store = SqliteAppsStore::open_in_memory().unwrap();
        let entries: Vec<(String, bool)> = SEEDED_IDS
            .iter()
            .rev()
            .map(|id| ((*id).to_owned(), *id != "precise-hbr"))
            .collect();
        let updated = store
            .replace_placements(&entries)
            .unwrap()
            .expect("an exact permutation renumbers and returns the registry");

        let expected: Vec<String> = entries.iter().map(|(id, _)| id.clone()).collect();
        let returned_ids: Vec<String> = updated.iter().map(|r| r.id.clone()).collect();
        assert_eq!(returned_ids, expected);

        for (position, (id, _)) in entries.iter().enumerate() {
            let registration = store.find_app(id).unwrap().unwrap();
            assert_eq!(
                registration.position,
                i64::try_from(position).unwrap(),
                "{id} position"
            );
        }
        assert!(
            !store
                .find_app("precise-hbr")
                .unwrap()
                .unwrap()
                .on_homescreen
        );
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

        let subset = vec![
            ("growth-chart".to_owned(), true),
            ("precise-hbr".to_owned(), true),
        ];
        assert!(store.replace_placements(&subset).unwrap().is_none());

        let dup = vec![
            ("growth-chart".to_owned(), true),
            ("medication-viewer".to_owned(), true),
            ("precise-hbr".to_owned(), true),
            ("growth-chart".to_owned(), true),
        ];
        assert!(store.replace_placements(&dup).unwrap().is_none());

        assert_eq!(
            before,
            ids_now(&store),
            "a rejected body must not reorder anything"
        );
    }
}
