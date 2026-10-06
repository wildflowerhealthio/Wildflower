//! [`AppRegistration`] — the authoritative `app_registrations` row: one row per
//! app, holding the global id, the homescreen placement (`position` /
//! `on_homescreen`), the catalogue facts (`name` / `subtitle` / the soft
//! `client_id` / the launch-readiness `requires_tunnel`), and the launch `url`
//! template. It is BOTH the diesel-mapped domain row and the `GET /apps` wire
//! item — one flat struct serialized directly (the "domain-is-wire" registration),
//! so there is no second projection to drift from.
//!
//! On the wire it is camelCase; `position` is omitted (the `GET /apps` array order
//! IS the display order) and `client_id` is projected as the derived boolean
//! `isSmart` (SMART ⇔ a `client_id` is present) — the column itself never leaves
//! the host.

use std::collections::HashSet;

use diesel::prelude::{Insertable, Queryable, Selectable};
use serde::{Serialize, Serializer};
use utoipa::ToSchema;

use super::AppUrl;
use crate::db::apps_store::{app_registrations, AppUrlColumn};

/// A registration row — one app's whole record. Diesel maps it to/from
/// `app_registrations` (the [`AppUrlColumn`] mapping on `url`); serde projects it
/// onto the wire item (`position` omitted, `client_id` → `isSmart`).
#[derive(Debug, Clone, PartialEq, Eq, Queryable, Selectable, Insertable, Serialize, ToSchema)]
#[diesel(table_name = app_registrations)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
#[serde(rename_all = "camelCase")]
pub struct AppRegistration {
    /// Stable id, globally unique (the registration PK).
    pub id: String,
    /// The homescreen display position (dense `0..n`, UNIQUE). Not on the wire —
    /// the `GET /apps` array order encodes it.
    #[serde(skip_serializing)]
    pub position: i64,
    /// Whether the app's tile shows on the home screen. Curated atomically by
    /// `PUT /home-screen` (see [`replace_placements`](super::AppsStore::replace_placements)).
    pub on_homescreen: bool,
    pub name: String,
    /// `None` means "no subtitle"; the wire omits an absent one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    /// The launch URL template: `{origin}` is replaced with the served origin at
    /// launch time, `{launch}` with a fresh per-launch nonce (see [`AppUrl`]). It
    /// is origin-independent, never a request-resolved redirect target — see
    /// `docs/Apps/Explanation.md`. Serialized as its canonical string.
    #[diesel(serialize_as = AppUrlColumn, deserialize_as = AppUrlColumn)]
    #[schema(value_type = String)]
    pub url: AppUrl,
    /// Soft reference to a gatekeeper `clients.client_id`; `None` for non-SMART
    /// apps. Never leaves the host: the wire carries the derived `isSmart` boolean.
    #[serde(rename = "isSmart", serialize_with = "serialize_client_id_as_is_smart")]
    #[schema(rename = "isSmart", value_type = bool)]
    pub client_id: Option<String>,
    /// Whether a launch resolves `{origin}` to the server's public origin rather
    /// than the served one (the Tunnel pill).
    pub requires_tunnel: bool,
}

impl AppRegistration {
    /// Whether this is a SMART app — derived from the soft `client_id` reference
    /// (present ⇔ SMART), the same value the wire carries as `isSmart`.
    #[must_use]
    pub fn is_smart(&self) -> bool {
        self.client_id.is_some()
    }
}

/// Whether `submitted` (the `PUT /home-screen` body's app ids, in submission order)
/// is an exact permutation of `current` (the live registry's ids): the same length,
/// no duplicates, and identical membership. `replace_placements` requires this
/// before it renumbers, so a stale or malformed body (a missing / duplicated /
/// unknown id) is rejected wholesale rather than partially applied. Pure set logic,
/// lifted out of the store so the DB implementation only supplies the two id sets.
#[must_use]
pub(crate) fn is_exact_registry_permutation(current: &HashSet<String>, submitted: &[&str]) -> bool {
    let submitted_set: HashSet<&str> = submitted.iter().copied().collect();
    submitted.len() == current.len()
        && submitted_set.len() == submitted.len()
        && submitted_set.iter().all(|id| current.contains(*id))
}

/// Serialize the soft `client_id` reference as the derived `isSmart` boolean — its
/// presence is the whole of what a client needs, and the id itself stays on the
/// host.
fn serialize_client_id_as_is_smart<S: Serializer>(
    client_id: &Option<String>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serializer.serialize_bool(client_id.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registration(client_id: Option<&str>) -> AppRegistration {
        AppRegistration {
            position: 3,
            name: "App X".to_owned(),
            client_id: client_id.map(str::to_owned),
            ..crate::domain::test_fake::registration("app-x")
        }
    }

    /// The wire item omits `position`, projects `client_id` to `isSmart`, and
    /// carries `url` as its canonical string; an absent subtitle is omitted.
    #[test]
    fn serializes_to_the_uniform_registration_shape() {
        let json = serde_json::to_value(registration(Some("client"))).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "id": "app-x",
                "onHomescreen": true,
                "name": "App X",
                "url": "https://example.com/launch",
                "isSmart": true,
                "requiresTunnel": false,
            }),
        );
        assert!(json.get("position").is_none(), "position stays on the host");
        assert!(
            json.get("clientId").is_none(),
            "client_id stays on the host"
        );
    }

    #[test]
    fn is_smart_follows_client_id() {
        assert!(registration(Some("c")).is_smart());
        assert!(!registration(None).is_smart());
    }

    fn id_set(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|id| (*id).to_owned()).collect()
    }

    #[test]
    fn exact_permutation_accepts_a_reordering_of_the_same_ids() {
        let current = id_set(&["a", "b", "c"]);
        assert!(is_exact_registry_permutation(&current, &["c", "a", "b"]));
    }

    #[test]
    fn exact_permutation_rejects_subset_superset_and_duplicates() {
        let current = id_set(&["a", "b", "c"]);
        assert!(
            !is_exact_registry_permutation(&current, &["a", "b"]),
            "a subset is not a permutation",
        );
        assert!(
            !is_exact_registry_permutation(&current, &["a", "b", "c", "d"]),
            "an unknown extra id is not a permutation",
        );
        assert!(
            !is_exact_registry_permutation(&current, &["a", "b", "b"]),
            "a duplicate (with a missing id) is not a permutation",
        );
    }
}
