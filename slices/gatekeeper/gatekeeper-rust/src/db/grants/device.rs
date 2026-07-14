//! Device grants in the store: the `device_grants` table and its single-kind query
//! bodies. A device grant is the durable record a device-code approval leaves for a
//! `(client_id, device_name)` pair — the identity token exchange stamps onto
//! `refresh_token_families.grant_id`, and the one a re-pairing upserts against.
//! Single-kind operations hit this concrete table; the cross-kind reads live in
//! [`super::general`].

use chrono::{DateTime, Utc};
use diesel::prelude::*;
use persistence_rust::PooledDieselConnection;
use uuid::Uuid;

use crate::db::shared::JsonStrings;
use crate::domain::error::GatekeeperError;
use crate::domain::grant::{CumulativeConsent, DeviceGrant};

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

/// Insert a brand-new device grant row — a plain single-table insert (no
/// transaction). Chiefly a test/seed helper; the flow uses
/// [`upsert_device_grant`]. The caller hands the concrete grant, so the store
/// never inspects a polymorphic value to choose the table.
pub(crate) fn create_device_grant(
    conn: &mut PooledDieselConnection,
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
    conn: &mut PooledDieselConnection,
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

/// Insert or update the standing **device** grant for
/// `(client_id, device_name)` in a single transaction on its one table,
/// with the same cumulative-consent semantics as
/// [`upsert_grant`](super::authorization_code::upsert_grant) — this is what makes a
/// device-code approval leave a durable record. Re-pairing the same device (same
/// name) absorbs the re-approval onto the existing grant; the table's
/// `UNIQUE(client_id, device_name)` keeps concurrent approvals race-safe.
pub(crate) fn upsert_device_grant(
    conn: &mut PooledDieselConnection,
    client_id: &str,
    device_name: &str,
    scopes: &[String],
    patient: Option<&str>,
    now: DateTime<Utc>,
) -> Result<(), GatekeeperError> {
    conn.transaction(|conn| {
        let existing: Option<DeviceGrant> = device_grants::table
            .filter(device_grants::client_id.eq(client_id))
            .filter(device_grants::device_name.eq(device_name))
            .select(DeviceGrant::as_select())
            .first(conn)
            .optional()?;
        match existing {
            Some(mut grant) => {
                grant.absorb_reapproval(scopes, patient, now);
                diesel::update(device_grants::table.find(&grant.id))
                    .set((
                        device_grants::scopes.eq(JsonStrings(grant.scopes)),
                        device_grants::granted_at.eq(grant.granted_at),
                        device_grants::patient.eq(grant.patient),
                    ))
                    .execute(conn)?;
            }
            None => {
                diesel::insert_into(device_grants::table)
                    .values(DeviceGrant {
                        id: Uuid::new_v4().to_string(),
                        client_id: client_id.to_owned(),
                        scopes: scopes.to_vec(),
                        granted_at: now,
                        last_used_at: None,
                        patient: patient.map(str::to_owned),
                        device_name: device_name.to_owned(),
                    })
                    .execute(conn)?;
            }
        }
        Ok(())
    })
    .map_err(|e: diesel::result::Error| {
        GatekeeperError::infrastructure("upsert_device_grant failed", e)
    })
}

#[cfg(test)]
mod tests {
    use chrono::Utc;

    use crate::db::SqliteGatekeeperStore;
    use crate::domain::GatekeeperStore as _;

    /// A device upsert mints a durable device grant, and re-pairing under the
    /// same `(client_id, device_name)` unions scopes onto the same row.
    #[test]
    fn upsert_device_grant_inserts_then_unions_scopes() {
        let store = SqliteGatekeeperStore::open_in_memory().expect("open in-memory store");
        let now = Utc::now();

        store
            .upsert_device_grant(
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

        store
            .upsert_device_grant(
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
        store
            .upsert_device_grant(
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
