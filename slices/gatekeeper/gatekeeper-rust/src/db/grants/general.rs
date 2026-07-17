//! Cross-kind grant queries — the pieces that span both concrete tables. The
//! `grants` SQL VIEW (`UNION ALL` of `authorization_code_grants` / `device_grants`
//! — shared columns + kind tag + NULLable payload columns) backs the two Owner-UI
//! reads ([`all_grants`], [`grant_by_id`]); the two id-keyed deletes
//! ([`delete_authorization_code_grant`], [`delete_device_grant`]) are the halves
//! the `revoke_grant` action composes with
//! the client's refresh-family expiry in one transaction. Single-kind operations
//! live in the sibling [`authorization_code`](super::authorization_code) /
//! [`device`](super::device) files.

use chrono::{DateTime, Utc};
use diesel::prelude::*;
use diesel::sqlite::SqliteConnection;

use super::authorization_code::authorization_code_grants;
use super::device::device_grants;
use crate::db::shared::{JsonStrings, UrlText};
use crate::domain::authorization_request::GrantType;
use crate::domain::gatekeeper_error::GatekeeperError;
use crate::domain::grant::{AuthorizationCodeGrant, DeviceGrant, Grant};

diesel::table! {
    /// The cross-kind `grants` VIEW: shared columns + the kind tag + each
    /// kind's payload column, NULLable for the other kind. SELECT-only.
    grants (id) {
        id -> Text,
        client_id -> Text,
        scopes -> Text,
        granted_at -> TimestamptzSqlite,
        last_used_at -> Nullable<TimestamptzSqlite>,
        patient -> Nullable<Text>,
        grant_type -> Text,
        redirect_uri -> Nullable<Text>,
        device_name -> Nullable<Text>,
    }
}

/// A row off the `grants` VIEW: the shared columns, the kind tag, and each
/// kind's payload column (NULL for the other kind). [`TryFrom`] repacks it
/// into the [`Grant`] enum, dispatching on the tag.
#[derive(Queryable)]
struct GrantViewRow {
    id: String,
    client_id: String,
    scopes: JsonStrings,
    granted_at: DateTime<Utc>,
    last_used_at: Option<DateTime<Utc>>,
    patient: Option<String>,
    grant_type: GrantType,
    redirect_uri: Option<UrlText>,
    device_name: Option<String>,
}

impl TryFrom<GrantViewRow> for Grant {
    type Error = GatekeeperError;

    fn try_from(row: GrantViewRow) -> Result<Self, Self::Error> {
        // The UNION ALL projects each kind's payload column NOT NULL from its
        // own table, so a NULL payload for the row's own kind is structurally
        // impossible — guarded anyway so a future view edit degrades to a
        // logged 500, never a panic.
        let make_missing_payload_error = || {
            GatekeeperError::infrastructure(
                "grants view row missing its kind's payload column",
                &row.id,
            )
        };
        match row.grant_type {
            GrantType::AuthorizationCode => {
                let redirect_uri = row.redirect_uri.ok_or_else(make_missing_payload_error)?.0;
                Ok(Grant::AuthorizationCode(AuthorizationCodeGrant {
                    id: row.id,
                    client_id: row.client_id,
                    scopes: row.scopes.0,
                    granted_at: row.granted_at,
                    last_used_at: row.last_used_at,
                    patient: row.patient,
                    redirect_uri,
                }))
            }
            GrantType::DeviceCode => {
                let device_name = row.device_name.ok_or_else(make_missing_payload_error)?;
                Ok(Grant::DeviceCode(DeviceGrant {
                    id: row.id,
                    client_id: row.client_id,
                    scopes: row.scopes.0,
                    granted_at: row.granted_at,
                    last_used_at: row.last_used_at,
                    patient: row.patient,
                    device_name,
                }))
            }
        }
    }
}

/// All grants in `granted_at` order — backs the Owner UI's access index
/// (Approved Apps + Authorized Devices). Reads the cross-kind `grants`
/// view.
pub(crate) fn all_grants(conn: &mut SqliteConnection) -> Result<Vec<Grant>, GatekeeperError> {
    grants::table
        .order(grants::granted_at)
        .load::<GrantViewRow>(conn)
        .map_err(|e| GatekeeperError::infrastructure("all_grants failed", e))?
        .into_iter()
        .map(Grant::try_from)
        .collect()
}

/// Load a single grant by primary id — a cross-kind read off the `grants`
/// view (ids are UUIDs, unique across both concrete tables).
pub(crate) fn grant_by_id(
    conn: &mut SqliteConnection,
    id: &str,
) -> Result<Option<Grant>, GatekeeperError> {
    grants::table
        .find(id)
        .first::<GrantViewRow>(conn)
        .optional()
        .map_err(|e| GatekeeperError::infrastructure("grant_by_id failed", e))?
        .map(Grant::try_from)
        .transpose()
}

/// Delete the authorization-code grant `id`, returning `true` iff a row was
/// removed. One half of a revoke; grant ids are UUIDs unique across both tables,
/// so at most one of this and [`delete_device_grant`] hits a row. The
/// `revoke_grant` action runs both plus
/// the client's refresh-family expiry inside one transaction, so standing consent
/// and standing credentials die together or not at all.
pub(crate) fn delete_authorization_code_grant(
    conn: &mut SqliteConnection,
    id: &str,
) -> Result<bool, GatekeeperError> {
    let deleted = diesel::delete(authorization_code_grants::table.find(id))
        .execute(conn)
        .map_err(|e| {
            GatekeeperError::infrastructure("delete_authorization_code_grant failed", e)
        })?;
    Ok(deleted > 0)
}

/// Delete the device grant `id`, returning `true` iff a row was removed — the
/// other half of a revoke (see [`delete_authorization_code_grant`]).
pub(crate) fn delete_device_grant(
    conn: &mut SqliteConnection,
    id: &str,
) -> Result<bool, GatekeeperError> {
    let deleted = diesel::delete(device_grants::table.find(id))
        .execute(conn)
        .map_err(|e| GatekeeperError::infrastructure("delete_device_grant failed", e))?;
    Ok(deleted > 0)
}

#[cfg(test)]
mod tests {
    use chrono::{DateTime, Utc};
    use proptest::prelude::*;
    use url::Url;
    use uuid::Uuid;

    use crate::db::test_support::{arb_opt_timestamp, arb_timestamp, arb_url};
    use crate::db::SqliteGatekeeperStore;
    use crate::domain::gatekeeper_error::GatekeeperError;
    use crate::domain::grant::{AuthorizationCodeGrant, DeviceGrant, Grant};
    use crate::domain::{GatekeeperStore as _, GatekeeperTx as _};

    /// The grant-revoke cascade (delete the grant + expire the client's
    /// refresh-token families in one transaction), inlined so the db test drives
    /// the real adapter directly rather than reaching up into a domain capability.
    /// Mirrors `domain::capabilities::grants::revoke_grant`.
    fn revoke_grant(
        store: &SqliteGatekeeperStore,
        grant_id: &str,
        client_id: &str,
        now: DateTime<Utc>,
    ) -> Result<(), GatekeeperError> {
        let removed = store.transaction(|tx| {
            let removed_code = tx.delete_authorization_code_grant(grant_id)?;
            let removed_device = tx.delete_device_grant(grant_id)?;
            tx.expire_refresh_token_families_for_client(client_id, now)?;
            Ok(removed_code || removed_device)
        })?;
        if removed {
            Ok(())
        } else {
            Err(GatekeeperError::GrantNotFound {
                id: grant_id.to_owned(),
            })
        }
    }

    /// The columns both grant kinds share, in field order.
    type SharedGrantFields = (
        String,
        String,
        Vec<String>,
        chrono::DateTime<Utc>,
        Option<chrono::DateTime<Utc>>,
        Option<String>,
    );

    fn arb_shared() -> impl Strategy<Value = SharedGrantFields> {
        (
            "[a-zA-Z0-9_-]{1,32}",
            "[a-zA-Z0-9_-]{1,32}",
            prop::collection::vec("[a-z][a-z0-9_]{0,15}", 0..5),
            arb_timestamp(),
            arb_opt_timestamp(),
            prop::option::of("[a-zA-Z0-9-]{1,32}"),
        )
    }

    fn arb_grant() -> impl Strategy<Value = Grant> {
        let code = (arb_shared(), arb_url()).prop_map(
            |((id, client_id, scopes, granted_at, last_used_at, patient), redirect_uri)| {
                Grant::AuthorizationCode(AuthorizationCodeGrant {
                    id,
                    client_id,
                    scopes,
                    granted_at,
                    last_used_at,
                    patient,
                    redirect_uri,
                })
            },
        );
        let device = (arb_shared(), "[ -~]{1,40}").prop_map(
            |((id, client_id, scopes, granted_at, last_used_at, patient), device_name)| {
                Grant::DeviceCode(DeviceGrant {
                    id,
                    client_id,
                    scopes,
                    granted_at,
                    last_used_at,
                    patient,
                    device_name,
                })
            },
        );
        prop_oneof![code, device]
    }

    fn read(url: &str) -> Url {
        Url::parse(url).expect("valid url")
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(48))]

        /// Both kinds round-trip through the view decoder: the concrete
        /// `create_*_grant` write lands in its table, and `grant_by_id`
        /// reconstructs the whole grant off the `grants` view.
        #[test]
        fn create_and_fetch_round_trip(grant in arb_grant()) {
            let store = SqliteGatekeeperStore::open_in_memory().expect("open in-memory store");
            match &grant {
                Grant::AuthorizationCode(g) => {
                    store.create_authorization_code_grant(g).expect("create code grant");
                }
                Grant::DeviceCode(g) => {
                    store.create_device_grant(g).expect("create device grant");
                }
            }
            let fetched = store
                .grant_by_id(grant.id())
                .expect("query")
                .expect("row present");
            prop_assert_eq!(fetched, grant);
        }
    }

    /// The two upsert keys don't collide: a code grant and a device grant for the
    /// same client coexist, and each lookup only sees its own kind.
    #[test]
    fn code_and_device_grants_coexist_per_client() {
        let store = SqliteGatekeeperStore::open_in_memory().expect("open in-memory store");
        let redirect = read("https://example.com/cb");
        let now = Utc::now();
        store
            .create_authorization_code_grant(&AuthorizationCodeGrant {
                id: Uuid::new_v4().to_string(),
                client_id: "client-a".to_owned(),
                scopes: vec!["read".to_owned()],
                granted_at: now,
                last_used_at: None,
                patient: None,
                redirect_uri: redirect.clone(),
            })
            .expect("code grant");
        store
            .create_device_grant(&DeviceGrant {
                id: Uuid::new_v4().to_string(),
                client_id: "client-a".to_owned(),
                scopes: vec!["openid".to_owned()],
                granted_at: now,
                last_used_at: None,
                patient: None,
                device_name: "Ada's laptop".to_owned(),
            })
            .expect("device grant");

        assert!(store
            .grant_by_client_and_redirect("client-a", &redirect)
            .expect("query")
            .is_some());
        assert!(store
            .device_grant_by_client_and_device_name("client-a", "Ada's laptop")
            .expect("query")
            .is_some());
        // The device lookup never returns the code grant, and vice versa.
        assert!(store
            .device_grant_by_client_and_device_name("client-a", "https://example.com/cb")
            .expect("query")
            .is_none());
        assert_eq!(store.all_grants().expect("list").len(), 2);
    }

    /// Revoking removes the concrete row — visible both through the view read
    /// and the concrete-table lookup — and, in the SAME transaction, expires
    /// the client's refresh-token families (deadline pulled to the revocation
    /// instant, live token stamped consumed): standing consent and standing
    /// credentials die together. A second revoke of the same id reports the
    /// miss.
    #[test]
    fn revoke_removes_the_row_and_expires_the_clients_families() {
        use crate::domain::refresh_token::{RefreshToken, RefreshTokenFamily};

        let store = SqliteGatekeeperStore::open_in_memory().expect("open in-memory store");
        store
            .create_device_grant(&DeviceGrant {
                id: Uuid::new_v4().to_string(),
                client_id: "client-a".to_owned(),
                scopes: vec!["openid".to_owned()],
                granted_at: Utc::now(),
                last_used_at: None,
                patient: None,
                device_name: "Ada's laptop".to_owned(),
            })
            .expect("insert");
        let id = store.all_grants().expect("list")[0].id().to_owned();
        // A standing credential minted under this client, live at revoke time.
        let family = RefreshTokenFamily {
            family_id: "fam-1".to_owned(),
            client_id: "client-a".to_owned(),
            scopes: vec!["openid".to_owned()],
            patient: None,
            issued_at: Utc::now(),
            expires_at: Utc::now() + chrono::Duration::days(90),
            authorization_code_hash: None,
            grant_id: Some(id.clone()),
        };
        let live = RefreshToken {
            token_hash: "live-token".to_owned(),
            family_id: "fam-1".to_owned(),
            issued_at: Utc::now(),
            consumed_at: None,
        };
        store
            .insert_refresh_token_family_row(&family)
            .expect("insert family");
        store
            .insert_refresh_token(&live)
            .expect("insert live token");

        let revoked_at = Utc::now();
        revoke_grant(&store, &id, "client-a", revoked_at).expect("revoke");
        assert!(store.grant_by_id(&id).expect("query").is_none());
        assert!(store
            .device_grant_by_client_and_device_name("client-a", "Ada's laptop")
            .expect("query")
            .is_none());
        // The family died with the consent: deadline pulled back, live token
        // stamped at the same instant.
        let (token, family) = store
            .refresh_token_with_family_by_hash("live-token")
            .expect("query")
            .expect("row kept for auditability");
        assert_eq!(family.expires_at, revoked_at);
        assert_eq!(token.consumed_at, Some(revoked_at));
        assert_eq!(
            revoke_grant(&store, &id, "client-a", Utc::now()),
            Err(GatekeeperError::GrantNotFound { id: id.clone() }),
            "a second revoke of the same id is a miss",
        );
    }
}
