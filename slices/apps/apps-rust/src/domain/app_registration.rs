//! [`AppRegistration`] — the authoritative `app_registry` row: one registration
//! per app of every kind, holding the global id, the CTI [`AppKind`] discriminator,
//! the homescreen placement (`position` / `enabled`), and the shared catalogue
//! facts (`name` / `subtitle` / `local_only` / the soft `client_id` / the
//! launch-readiness `requires_tunnel`). It is BOTH the diesel-mapped domain row
//! and the uniform `GET /apps` wire item — one flat struct serialized directly
//! (the "domain-is-wire" half of `docs/Persistence/Polymorphic Rows Explanation.md`),
//! so there is no union to narrow and no second projection to drift from.
//!
//! On the wire it is camelCase; `position` is omitted (the `GET /apps` array order
//! IS the display order) and `client_id` is projected as the derived boolean
//! `smart` (SMART ⇔ a `client_id` is present) — the column itself never leaves the
//! host. The per-kind detail shapes (`CloudAppDetail` etc.) carry these same fields
//! plus their payload; see the per-kind domain modules.

use diesel::prelude::{Insertable, Queryable, Selectable};
use serde::{Serialize, Serializer};
use utoipa::ToSchema;

use super::AppKind;
use crate::db::columns::AppKindColumn;
use crate::db::schema::app_registry;

/// A registration row — the parent of one app's CTI record. Diesel maps it to/from
/// `app_registry` (the [`AppKindColumn`] mapping on `kind`); serde projects it onto
/// the `GET /apps` wire item (`position` omitted, `client_id` → `smart`).
#[derive(Debug, Clone, PartialEq, Eq, Queryable, Selectable, Insertable, Serialize, ToSchema)]
#[diesel(table_name = app_registry)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
#[serde(rename_all = "camelCase")]
pub struct AppRegistration {
    /// Stable id, globally unique across all kinds (the parent PK).
    pub id: String,
    /// The CTI discriminator — which child table holds this id's payload.
    #[diesel(serialize_as = AppKindColumn, deserialize_as = AppKindColumn)]
    pub kind: AppKind,
    /// The homescreen display position (dense `0..n`, UNIQUE). Not on the wire —
    /// the `GET /apps` array order encodes it.
    #[serde(skip_serializing)]
    pub position: i64,
    /// The homescreen `enabled` flag.
    pub enabled: bool,
    pub name: String,
    /// `None` means "no subtitle"; the wire omits an absent one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    /// The declared no-egress flag (a UI badge this pass).
    pub local_only: bool,
    /// Soft reference to a gatekeeper `clients.client_id`; `None` for non-SMART
    /// apps. Never leaves the host: the wire carries the derived `smart` boolean.
    #[serde(rename = "smart", serialize_with = "serialize_client_id_as_smart")]
    #[schema(rename = "smart", value_type = bool)]
    pub client_id: Option<String>,
    /// Whether a launch must bring the tunnel up first (a launch-readiness pill).
    /// `false` for system / self-hosted; meaningful only for cloud apps.
    pub requires_tunnel: bool,
}

impl AppRegistration {
    /// Whether this is a SMART app — derived from the soft `client_id` reference
    /// (present ⇔ SMART), the same value the wire carries as `smart`.
    #[must_use]
    pub fn smart(&self) -> bool {
        self.client_id.is_some()
    }
}

/// Serialize the soft `client_id` reference as the derived `smart` boolean — its
/// presence is the whole of what a client needs, and the id itself stays on the
/// host.
fn serialize_client_id_as_smart<S: Serializer>(
    client_id: &Option<String>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serializer.serialize_bool(client_id.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registration(kind: AppKind, client_id: Option<&str>) -> AppRegistration {
        AppRegistration {
            id: "app-x".to_owned(),
            kind,
            position: 3,
            enabled: true,
            name: "App X".to_owned(),
            subtitle: None,
            local_only: false,
            client_id: client_id.map(str::to_owned),
            requires_tunnel: false,
        }
    }

    /// The wire item omits `position` and projects `client_id` to `smart`; an
    /// absent subtitle is omitted.
    #[test]
    fn serializes_to_the_uniform_registration_shape() {
        let json = serde_json::to_value(registration(AppKind::Cloud, Some("client"))).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "id": "app-x",
                "kind": "cloud",
                "enabled": true,
                "name": "App X",
                "localOnly": false,
                "smart": true,
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
    fn smart_follows_client_id() {
        assert!(registration(AppKind::Cloud, Some("c")).smart());
        assert!(!registration(AppKind::System, None).smart());
    }
}
