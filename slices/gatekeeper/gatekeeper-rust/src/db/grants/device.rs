//! Device grants in the store: the `device_grants` table and its single-kind query
//! bodies. A device grant is the durable record a device-code approval leaves for a
//! `(client_id, device_name)` pair — the identity token exchange stamps onto
//! `refresh_token_families.grant_id`, and the one a re-pairing upserts against.
//! Single-kind operations hit this concrete table; the cross-kind reads live in
//! [`super::general`].

use diesel::prelude::*;
use diesel::sqlite::SqliteConnection;

use crate::db::shared::JsonStrings;
use crate::domain::gatekeeper_error::GatekeeperError;
use crate::domain::grant::DeviceGrant;

diesel::table! {
    device_grants (id) {
        id -> Text,
        client_id -> Text,
        scopes -> Text,
        granted_at -> TimestamptzSqlite,
        last_used_at -> Nullable<TimestamptzSqlite>,
        patient -> Nullable<Text>,
        device_name -> Text,
    }
}

/// Insert a brand-new device grant row — a plain single-table insert. The
/// insert branch of a first-time pairing, and a test/seed helper; the
/// scope-union re-pairing flow is
/// [`upsert_device_grant`](crate::domain::actions::upsert_device_grant), which
/// reads then chooses this or [`update_device_grant`]. The caller hands the
/// concrete grant, so the store never inspects a polymorphic value to choose the
/// table.
pub(crate) fn create_device_grant(
    conn: &mut SqliteConnection,
    grant: &DeviceGrant,
) -> Result<(), GatekeeperError> {
    diesel::insert_into(device_grants::table)
        .values(grant.clone())
        .execute(conn)
        .map_err(|e| GatekeeperError::infrastructure("create_device_grant failed", e))?;
    Ok(())
}

/// Find an existing device grant for the (`client_id`, `device_name`) pair —
/// the identity a re-pairing upserts against, and the lookup token exchange
/// uses to stamp `refresh_token_families.grant_id`. Hits the concrete
/// table.
pub(crate) fn device_grant_by_client_and_device_name(
    conn: &mut SqliteConnection,
    client_id: &str,
    device_name: &str,
) -> Result<Option<DeviceGrant>, GatekeeperError> {
    device_grants::table
        .filter(device_grants::client_id.eq(client_id))
        .filter(device_grants::device_name.eq(device_name))
        .select(DeviceGrant::as_select())
        .first(conn)
        .optional()
        .map_err(|e| {
            GatekeeperError::infrastructure("device_grant_by_client_and_device_name failed", e)
        })
}

/// Overwrite the mutable fields (`scopes`, `granted_at`, `patient`) of the
/// device grant identified by `grant.id` — the write half of a device
/// re-pairing, after
/// [`upsert_device_grant`](crate::domain::actions::upsert_device_grant) has read
/// the standing grant and folded the re-approval into it via
/// [`absorb_reapproval`](crate::domain::grant::CumulativeConsent). The action
/// runs the read + this write inside one `BEGIN IMMEDIATE` transaction (the
/// concurrency rationale it shares with the authorization-code upsert); this
/// body is just the `UPDATE`.
pub(crate) fn update_device_grant(
    conn: &mut SqliteConnection,
    grant: &DeviceGrant,
) -> Result<(), GatekeeperError> {
    diesel::update(device_grants::table.find(&grant.id))
        .set((
            device_grants::scopes.eq(JsonStrings(grant.scopes.clone())),
            device_grants::granted_at.eq(grant.granted_at),
            device_grants::patient.eq(grant.patient.clone()),
        ))
        .execute(conn)
        .map_err(|e| GatekeeperError::infrastructure("update_device_grant failed", e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use chrono::Utc;

    use crate::db::SqliteGatekeeperStore;
    use crate::domain::actions;
    use crate::domain::GatekeeperStore as _;

    /// The `upsert_device_grant` action over the real `SQLite` adapter: a first
    /// pairing mints a durable device grant (via `create_device_grant`), and
    /// re-pairing under the same `(client_id, device_name)` reads then unions
    /// scopes onto the same row through `update_device_grant` — all inside the
    /// action's `BEGIN IMMEDIATE`. A different device name is a distinct grant.
    #[test]
    fn upsert_action_inserts_then_unions_scopes_over_sqlite() {
        let store = SqliteGatekeeperStore::open_in_memory().expect("open in-memory store");
        let now = Utc::now();

        actions::upsert_device_grant(
            &store,
            "client-a",
            "Ada's laptop",
            &["openid".to_owned()],
            None,
            now,
        )
        .expect("insert");
        let grant = store
            .device_grant_by_client_and_device_name("client-a", "Ada's laptop")
            .expect("query")
            .expect("present");
        assert_eq!(grant.scopes, vec!["openid".to_owned()]);
        assert_eq!(grant.device_name, "Ada's laptop");

        actions::upsert_device_grant(
            &store,
            "client-a",
            "Ada's laptop",
            &["openid".to_owned(), "offline_access".to_owned()],
            None,
            Utc::now(),
        )
        .expect("update");
        let updated = store
            .device_grant_by_client_and_device_name("client-a", "Ada's laptop")
            .expect("query")
            .expect("present");
        assert_eq!(
            updated.id, grant.id,
            "re-pairing the same device updates one grant"
        );
        assert_eq!(
            updated.scopes,
            vec!["openid".to_owned(), "offline_access".to_owned()],
        );
        assert_eq!(store.all_grants().expect("list").len(), 1);

        // A different device name for the same client is a distinct grant.
        actions::upsert_device_grant(
            &store,
            "client-a",
            "Ada's phone",
            &["openid".to_owned()],
            None,
            Utc::now(),
        )
        .expect("insert second device");
        assert_eq!(store.all_grants().expect("list").len(), 2);
    }
}
