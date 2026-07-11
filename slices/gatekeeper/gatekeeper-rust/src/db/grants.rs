//! Grant queries — ONE TABLE PER CONCRETE KIND. Single-kind operations
//! (upserts, keyed lookups) hit their concrete table
//! (`authorization_code_grants` / `device_grants`) as single-table statements;
//! cross-kind reads ([`GatekeeperStore::all_grants`],
//! [`GatekeeperStore::grant_by_id`]) come off the `grants` SQL VIEW
//! (`UNION ALL` of the two tables — shared columns + kind tag + NULLable
//! payload columns). There is no parent registry, so there is no
//! parent-implies-child invariant to enforce and no cross-table transaction
//! anywhere in this file except the revoke (grant delete + refresh-family
//! expiry, which must be atomic together).

use chrono::{DateTime, Utc};
use diesel::prelude::*;
use url::Url;
use uuid::Uuid;

use crate::db::columns::{JsonStrings, UrlText};
use crate::db::schema::{authorization_code_grants, device_grants, grants};
use crate::db::GatekeeperStore;
use crate::domain::authorization_request::GrantType;
use crate::domain::error::GatekeeperError;
use crate::domain::grant::{AuthorizationCodeGrant, CumulativeConsent, DeviceGrant, Grant};

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
        let missing_payload = || {
            GatekeeperError::backend("grants view row missing its kind's payload column", &row.id)
        };
        match row.grant_type {
            GrantType::AuthorizationCode => {
                let redirect_uri = row.redirect_uri.ok_or_else(missing_payload)?.0;
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
                let device_name = row.device_name.ok_or_else(missing_payload)?;
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

impl GatekeeperStore {
    /// All grants in `granted_at` order — backs the Owner UI's access index
    /// (Approved Apps + Authorized Devices). Reads the cross-kind `grants`
    /// view.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Backend`] if the view read fails or a returned row
    /// cannot be mapped to a [`Grant`].
    pub fn all_grants(&self) -> Result<Vec<Grant>, GatekeeperError> {
        grants::table
            .order(grants::granted_at)
            .load::<GrantViewRow>(&mut self.conn()?)
            .map_err(|e| GatekeeperError::backend("all_grants failed", e))?
            .into_iter()
            .map(Grant::try_from)
            .collect()
    }

    /// Load a single grant by primary id — a cross-kind read off the `grants`
    /// view (ids are UUIDs, unique across both concrete tables).
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Backend`] if the view read fails or the returned row
    /// cannot be mapped to a [`Grant`].
    pub fn grant_by_id(&self, id: &str) -> Result<Option<Grant>, GatekeeperError> {
        grants::table
            .find(id)
            .first::<GrantViewRow>(&mut self.conn()?)
            .optional()
            .map_err(|e| GatekeeperError::backend("grant_by_id failed", e))?
            .map(Grant::try_from)
            .transpose()
    }

    /// Find an existing authorization-code grant for the (`client_id`,
    /// `redirect_uri`) pair so `/authorize` can decide whether to short-circuit
    /// the consent prompt. A single-kind lookup, so it hits the concrete table
    /// and returns the concrete struct — a device grant for the same client
    /// can never satisfy it.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Backend`] if the select query fails or a returned
    /// row cannot be mapped to an [`AuthorizationCodeGrant`].
    pub fn grant_by_client_and_redirect(
        &self,
        client_id: &str,
        redirect_uri: &Url,
    ) -> Result<Option<AuthorizationCodeGrant>, GatekeeperError> {
        authorization_code_grants::table
            .filter(authorization_code_grants::client_id.eq(client_id))
            .filter(authorization_code_grants::redirect_uri.eq(redirect_uri.as_str()))
            .select(AuthorizationCodeGrant::as_select())
            .first(&mut self.conn()?)
            .optional()
            .map_err(|e| GatekeeperError::backend("grant_by_client_and_redirect failed", e))
    }

    /// Find an existing device grant for the (`client_id`, `device_name`) pair —
    /// the identity a re-pairing upserts against, and the lookup token exchange
    /// uses to stamp `refresh_token_families.grant_id`. Hits the concrete
    /// table.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Backend`] if the select query fails or a returned
    /// row cannot be mapped to a [`DeviceGrant`].
    pub fn device_grant_by_client_and_device_name(
        &self,
        client_id: &str,
        device_name: &str,
    ) -> Result<Option<DeviceGrant>, GatekeeperError> {
        device_grants::table
            .filter(device_grants::client_id.eq(client_id))
            .filter(device_grants::device_name.eq(device_name))
            .select(DeviceGrant::as_select())
            .first(&mut self.conn()?)
            .optional()
            .map_err(|e| {
                GatekeeperError::backend("device_grant_by_client_and_device_name failed", e)
            })
    }

    /// Insert a brand-new grant row into its kind's concrete table — a plain
    /// single-table insert (no parent, no transaction). Chiefly a test/seed
    /// helper; the flows use [`Self::upsert_grant`] /
    /// [`Self::upsert_device_grant`].
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Backend`] if the insert fails (for example a
    /// unique-constraint violation).
    pub fn create_grant(&self, grant: &Grant) -> Result<(), GatekeeperError> {
        let backend = |e| GatekeeperError::backend("create_grant failed", e);
        let mut conn = self.conn()?;
        match grant {
            Grant::AuthorizationCode(grant) => {
                diesel::insert_into(authorization_code_grants::table)
                    .values(grant.clone())
                    .execute(&mut conn)
                    .map_err(backend)?;
            }
            Grant::DeviceCode(grant) => {
                diesel::insert_into(device_grants::table)
                    .values(grant.clone())
                    .execute(&mut conn)
                    .map_err(backend)?;
            }
        }
        Ok(())
    }

    /// Insert or update the standing **authorization-code** grant for
    /// `(client_id, redirect_uri)` in a single transaction on its one table.
    /// Consent is cumulative ([`CumulativeConsent`]): an existing grant absorbs
    /// the re-approval (scope union, refreshed `granted_at`/`patient`). The
    /// read-merge-write under one transaction (paired with the table's
    /// `UNIQUE(client_id, redirect_uri)`) means two concurrent approvals can't
    /// both insert a duplicate grant.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Backend`] if the transaction, the read, or the
    /// insert/update fails.
    pub fn upsert_grant(
        &self,
        client_id: &str,
        redirect_uri: &Url,
        scopes: &[String],
        patient: Option<&str>,
        now: DateTime<Utc>,
    ) -> Result<(), GatekeeperError> {
        let mut conn = self.conn()?;
        conn.transaction(|conn| {
            let existing: Option<AuthorizationCodeGrant> = authorization_code_grants::table
                .filter(authorization_code_grants::client_id.eq(client_id))
                .filter(authorization_code_grants::redirect_uri.eq(redirect_uri.as_str()))
                .select(AuthorizationCodeGrant::as_select())
                .first(conn)
                .optional()?;
            match existing {
                Some(mut grant) => {
                    grant.absorb_reapproval(scopes, patient, now);
                    diesel::update(authorization_code_grants::table.find(&grant.id))
                        .set((
                            authorization_code_grants::scopes.eq(JsonStrings(grant.scopes)),
                            authorization_code_grants::granted_at.eq(grant.granted_at),
                            authorization_code_grants::patient.eq(grant.patient),
                        ))
                        .execute(conn)?;
                }
                None => {
                    diesel::insert_into(authorization_code_grants::table)
                        .values(AuthorizationCodeGrant {
                            id: Uuid::new_v4().to_string(),
                            client_id: client_id.to_owned(),
                            scopes: scopes.to_vec(),
                            granted_at: now,
                            last_used_at: None,
                            patient: patient.map(str::to_owned),
                            redirect_uri: redirect_uri.clone(),
                        })
                        .execute(conn)?;
                }
            }
            Ok(())
        })
        .map_err(|e: diesel::result::Error| GatekeeperError::backend("upsert_grant failed", e))
    }

    /// Insert or update the standing **device** grant for
    /// `(client_id, device_name)` in a single transaction on its one table,
    /// with the same cumulative-consent semantics as [`Self::upsert_grant`] —
    /// this is what makes a device-code approval leave a durable record.
    /// Re-pairing the same device (same name) absorbs the re-approval onto the
    /// existing grant; the table's `UNIQUE(client_id, device_name)` keeps
    /// concurrent approvals race-safe.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Backend`] if the transaction, the read, or the
    /// insert/update fails.
    pub fn upsert_device_grant(
        &self,
        client_id: &str,
        device_name: &str,
        scopes: &[String],
        patient: Option<&str>,
        now: DateTime<Utc>,
    ) -> Result<(), GatekeeperError> {
        let mut conn = self.conn()?;
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
            GatekeeperError::backend("upsert_device_grant failed", e)
        })
    }

    /// Revoke a grant and expire the refresh-token families of its client in a
    /// single transaction, returning `true` if the grant existed. Doing both in
    /// one transaction means a partial failure can't leave the grant deleted
    /// while `offline_access` refresh tokens stay live (up to 90 days) —
    /// standing consent and standing credentials die together or not at all.
    ///
    /// The delete targets BOTH concrete tables rather than dispatching on the
    /// kind: grant ids are UUIDs unique across the two tables, so exactly one
    /// (or neither) delete affects a row, and the caller doesn't have to
    /// thread the kind through. Families are expired in place (deadline pulled
    /// to `now`, live tokens stamped consumed), not deleted, so the lineage
    /// stays auditable.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Backend`] if the transaction or any statement fails.
    pub fn revoke_grant_and_expire_client_families(
        &self,
        grant_id: &str,
        client_id: &str,
        now: DateTime<Utc>,
    ) -> Result<bool, GatekeeperError> {
        use crate::db::schema::{refresh_token_families, refresh_tokens};
        let mut conn = self.conn()?;
        conn.transaction(|conn| {
            let from_code_grants =
                diesel::delete(authorization_code_grants::table.find(grant_id)).execute(conn)?;
            let from_device_grants =
                diesel::delete(device_grants::table.find(grant_id)).execute(conn)?;
            diesel::update(
                refresh_tokens::table
                    .filter(refresh_tokens::consumed_at.is_null())
                    .filter(
                        refresh_tokens::family_id.eq_any(
                            refresh_token_families::table
                                .filter(refresh_token_families::client_id.eq(client_id))
                                .select(refresh_token_families::family_id),
                        ),
                    ),
            )
            .set(refresh_tokens::consumed_at.eq(now))
            .execute(conn)?;
            diesel::update(
                refresh_token_families::table
                    .filter(refresh_token_families::client_id.eq(client_id)),
            )
            .set(refresh_token_families::expires_at.eq(now))
            .execute(conn)?;
            Ok(from_code_grants + from_device_grants > 0)
        })
        .map_err(|e: diesel::result::Error| {
            GatekeeperError::backend("revoke_grant_and_expire_client_families failed", e)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::{arb_opt_timestamp, arb_timestamp, arb_url};
    use proptest::prelude::*;

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

        /// Both kinds round-trip through the view decoder: `create_grant`
        /// writes the concrete table, and `grant_by_id` reconstructs the whole
        /// grant off the `grants` view.
        #[test]
        fn create_and_fetch_round_trip(grant in arb_grant()) {
            let store = GatekeeperStore::open_in_memory().expect("open in-memory store");
            store.create_grant(&grant).expect("create");
            let fetched = store
                .grant_by_id(grant.id())
                .expect("query")
                .expect("row present");
            prop_assert_eq!(fetched, grant);
        }
    }

    /// A code-flow upsert inserts a fresh authorization-code grant, then unions
    /// scopes on re-approval (cumulative consent) rather than replacing them.
    #[test]
    fn upsert_grant_inserts_then_unions_scopes() {
        let store = GatekeeperStore::open_in_memory().expect("open in-memory store");
        let redirect = read("https://example.com/cb");
        let now = Utc::now();

        store
            .upsert_grant(
                "client-a",
                &redirect,
                &["read".to_owned()],
                Some("pat-1"),
                now,
            )
            .expect("insert");
        let grant = store
            .grant_by_client_and_redirect("client-a", &redirect)
            .expect("query")
            .expect("present");
        assert_eq!(grant.scopes, vec!["read".to_owned()]);
        assert_eq!(grant.patient.as_deref(), Some("pat-1"));

        // Re-approve with an overlapping + a new scope: union, not replace.
        store
            .upsert_grant(
                "client-a",
                &redirect,
                &["read".to_owned(), "write".to_owned()],
                Some("pat-2"),
                Utc::now(),
            )
            .expect("update");
        let updated = store
            .grant_by_client_and_redirect("client-a", &redirect)
            .expect("query")
            .expect("present");
        assert_eq!(
            updated.id, grant.id,
            "the same grant is updated, not duplicated"
        );
        assert_eq!(updated.scopes, vec!["read".to_owned(), "write".to_owned()]);
        assert_eq!(updated.patient.as_deref(), Some("pat-2"));
        assert_eq!(store.all_grants().expect("list").len(), 1);
    }

    /// A device upsert mints a durable device grant, and re-pairing under the
    /// same `(client_id, device_name)` unions scopes onto the same row.
    #[test]
    fn upsert_device_grant_inserts_then_unions_scopes() {
        let store = GatekeeperStore::open_in_memory().expect("open in-memory store");
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

    /// The two upsert keys don't collide: a code grant and a device grant for the
    /// same client coexist, and each lookup only sees its own kind.
    #[test]
    fn code_and_device_grants_coexist_per_client() {
        let store = GatekeeperStore::open_in_memory().expect("open in-memory store");
        let redirect = read("https://example.com/cb");
        let now = Utc::now();
        store
            .upsert_grant("client-a", &redirect, &["read".to_owned()], None, now)
            .expect("code grant");
        store
            .upsert_device_grant(
                "client-a",
                "Ada's laptop",
                &["openid".to_owned()],
                None,
                now,
            )
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

        let store = GatekeeperStore::open_in_memory().expect("open in-memory store");
        store
            .upsert_device_grant(
                "client-a",
                "Ada's laptop",
                &["openid".to_owned()],
                None,
                Utc::now(),
            )
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
            .insert_refresh_token_family(&family, &live)
            .expect("insert family");

        let revoked_at = Utc::now();
        assert!(store
            .revoke_grant_and_expire_client_families(&id, "client-a", revoked_at)
            .expect("revoke"));
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
        assert!(
            !store
                .revoke_grant_and_expire_client_families(&id, "client-a", Utc::now())
                .expect("second revoke"),
            "a second revoke of the same id is a miss",
        );
    }
}
