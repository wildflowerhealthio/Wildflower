use chrono::{DateTime, Utc};
use rusqlite::types::{FromSqlError, Type};
use rusqlite::{params, OptionalExtension};
use url::Url;

use uuid::Uuid;

use crate::db::GatekeeperStore;
use crate::domain::authorization_request::GrantType;
use crate::domain::grant::{Grant, GrantKind};
use persistence_rust::{DbResult, JsonColumn};

/// The one SELECT every grant read uses: the parent `grants` columns plus both
/// LEFT-JOINed children. [`grant_from_row`] picks the child columns its
/// `grant_type` needs — a code grant's `redirect_uri`, a device grant's
/// `device_name`. Mirrors apps' `APP_COLUMNS` (`apps-rust/src/db/reads.rs`).
const GRANT_COLUMNS: &str =
    "g.id, g.client_id, g.scopes, g.granted_at, g.last_used_at, g.patient, \
     g.grant_type, \
     ac.redirect_uri, \
     dc.device_name \
     FROM grants g \
     LEFT JOIN authorization_code_grants ac ON ac.id = g.id \
     LEFT JOIN device_grants dc ON dc.id = g.id";

/// Decode one [`GRANT_COLUMNS`] row into a whole [`Grant`], dispatching the kind
/// payload on the stored `grant_type`.
///
/// The single enforcement point of parent-implies-child: a parent whose expected
/// child row is missing reads `NULL` into a non-nullable payload field and
/// surfaces as a typed error (a logged 500 at the handler seam), never a partial
/// `Grant`. Mirrors `app_from_row` (`apps-rust/src/db/reads.rs`).
fn grant_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Grant> {
    let kind = match row.get::<_, GrantType>("grant_type")? {
        GrantType::AuthorizationCode => GrantKind::AuthorizationCode {
            redirect_uri: get_child(row, "redirect_uri")?,
        },
        GrantType::DeviceCode => GrantKind::DeviceCode {
            device_name: get_child(row, "device_name")?,
        },
    };
    Ok(Grant {
        id: row.get("id")?,
        client_id: row.get("client_id")?,
        scopes: row.get("scopes")?,
        granted_at: row.get("granted_at")?,
        last_used_at: row.get("last_used_at")?,
        patient: row.get("patient")?,
        kind,
    })
}

/// Read a required child column, mapping a `NULL` (the LEFT JOIN found no child
/// row) to a typed error that names the column — the "parent has no child row"
/// failure [`grant_from_row`] promises. Mirrors apps' `get_child`.
fn get_child<T: rusqlite::types::FromSql>(
    row: &rusqlite::Row<'_>,
    column: &str,
) -> rusqlite::Result<T> {
    row.get(column).map_err(|error| match error {
        rusqlite::Error::InvalidColumnType(index, name, Type::Null) => {
            rusqlite::Error::FromSqlConversionFailure(
                index,
                Type::Null,
                Box::new(FromSqlError::Other(
                    format!("child row missing: {name} is NULL for this grant_type").into(),
                )),
            )
        }
        other => other,
    })
}

impl GatekeeperStore {
    /// All grants in `granted_at` order — backs the Owner UI's access index
    /// (Approved Apps + Authorized Devices).
    ///
    /// # Errors
    ///
    /// Returns a `rusqlite::Error` if preparing or running the select query fails
    /// or any returned row cannot be mapped to a [`Grant`].
    pub fn all_grants(&self) -> DbResult<Vec<Grant>> {
        let conn = self.conn().lock();
        let mut stmt = conn.prepare(&format!("SELECT {GRANT_COLUMNS} ORDER BY g.granted_at"))?;
        let rows: rusqlite::Result<Vec<_>> = stmt.query_map([], grant_from_row)?.collect();
        rows
    }

    /// Load a single grant by primary id.
    ///
    /// # Errors
    ///
    /// Returns a `rusqlite::Error` if the select query fails or a returned row
    /// cannot be mapped to a [`Grant`].
    pub fn grant_by_id(&self, id: &str) -> DbResult<Option<Grant>> {
        self.conn()
            .lock()
            .query_row(
                &format!("SELECT {GRANT_COLUMNS} WHERE g.id = ?1"),
                params![id],
                grant_from_row,
            )
            .optional()
    }

    /// Find an existing authorization-code grant for the (`client_id`,
    /// `redirect_uri`) pair so `/authorize` can decide whether to short-circuit
    /// the consent prompt. Keyed on the code-grant child, so a device grant for
    /// the same client can never satisfy it.
    ///
    /// # Errors
    ///
    /// Returns a `rusqlite::Error` if the select query fails or a returned row
    /// cannot be mapped to a [`Grant`].
    pub fn grant_by_client_and_redirect(
        &self,
        client_id: &str,
        redirect_uri: &Url,
    ) -> DbResult<Option<Grant>> {
        self.conn()
            .lock()
            .query_row(
                &format!("SELECT {GRANT_COLUMNS} WHERE ac.client_id = ?1 AND ac.redirect_uri = ?2"),
                params![client_id, redirect_uri.as_str()],
                grant_from_row,
            )
            .optional()
    }

    /// Find an existing device grant for the (`client_id`, `device_name`) pair —
    /// the identity a re-pairing upserts against, and the lookup token exchange
    /// uses to stamp `refresh_token_families.grant_id`.
    ///
    /// # Errors
    ///
    /// Returns a `rusqlite::Error` if the select query fails or a returned row
    /// cannot be mapped to a [`Grant`].
    pub fn device_grant_by_client_and_device_name(
        &self,
        client_id: &str,
        device_name: &str,
    ) -> DbResult<Option<Grant>> {
        self.conn()
            .lock()
            .query_row(
                &format!("SELECT {GRANT_COLUMNS} WHERE dc.client_id = ?1 AND dc.device_name = ?2"),
                params![client_id, device_name],
                grant_from_row,
            )
            .optional()
    }

    /// Insert a brand-new grant row — the parent plus the child its kind implies,
    /// in one transaction (parent first so the child FK resolves), upholding the
    /// parent-implies-child invariant. Chiefly a test/seed helper; the flows use
    /// [`Self::upsert_grant`] / [`Self::upsert_device_grant`].
    ///
    /// # Errors
    ///
    /// Returns a `rusqlite::Error` if opening the transaction, either insert, or
    /// the commit fails (for example a unique-constraint violation).
    pub fn create_grant(&self, grant: &Grant) -> DbResult<()> {
        let mut guard = self.conn().lock();
        let tx = guard.transaction()?;
        tx.execute(
            "INSERT INTO grants (id, client_id, scopes, granted_at, last_used_at, patient, grant_type) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                grant.id,
                grant.client_id,
                grant.scopes,
                grant.granted_at,
                grant.last_used_at,
                grant.patient,
                grant.kind.grant_type(),
            ],
        )?;
        insert_child(&tx, &grant.id, &grant.client_id, &grant.kind)?;
        tx.commit()
    }

    /// Insert or update the standing **authorization-code** grant for
    /// `(client_id, redirect_uri)` in a single transaction. Consent is
    /// cumulative: an existing grant's scopes are unioned with `scopes`, and
    /// `granted_at`/`patient` are refreshed. The read-merge-write under one
    /// transaction (paired with the child's `UNIQUE(client_id, redirect_uri)`)
    /// means two concurrent approvals can't both insert a duplicate grant.
    ///
    /// # Errors
    ///
    /// Returns a `rusqlite::Error` if opening the transaction, the read, the
    /// insert/update, or the commit fails.
    pub fn upsert_grant(
        &self,
        client_id: &str,
        redirect_uri: &Url,
        scopes: &[String],
        patient: Option<&str>,
        now: DateTime<Utc>,
    ) -> DbResult<()> {
        let mut guard = self.conn().lock();
        let tx = guard.transaction()?;
        let existing: Option<(String, JsonColumn<Vec<String>>)> = tx
            .query_row(
                "SELECT g.id, g.scopes FROM authorization_code_grants ac \
                 JOIN grants g ON g.id = ac.id \
                 WHERE ac.client_id = ?1 AND ac.redirect_uri = ?2",
                params![client_id, redirect_uri.as_str()],
                |row| Ok((row.get("id")?, row.get("scopes")?)),
            )
            .optional()?;
        if let Some((id, JsonColumn(merged))) = existing {
            let scopes_json = JsonColumn(union_scopes(merged, scopes));
            tx.execute(
                "UPDATE grants SET scopes = ?2, granted_at = ?3, patient = ?4 WHERE id = ?1",
                params![id, scopes_json, now, patient],
            )?;
        } else {
            let id = Uuid::new_v4().to_string();
            insert_parent(
                &tx,
                &id,
                client_id,
                scopes,
                patient,
                now,
                GrantType::AuthorizationCode,
            )?;
            insert_authorization_code_child(&tx, &id, client_id, redirect_uri)?;
        }
        tx.commit()
    }

    /// Insert or update the standing **device** grant for
    /// `(client_id, device_name)` in a single transaction, with the same
    /// cumulative-scopes semantics as [`Self::upsert_grant`] — this is what makes
    /// a device-code approval leave a durable record. Re-pairing the same device
    /// (same name) unions scopes onto the existing grant; the child's
    /// `UNIQUE(client_id, device_name)` keeps concurrent approvals race-safe.
    ///
    /// # Errors
    ///
    /// Returns a `rusqlite::Error` if opening the transaction, the read, the
    /// insert/update, or the commit fails.
    pub fn upsert_device_grant(
        &self,
        client_id: &str,
        device_name: &str,
        scopes: &[String],
        patient: Option<&str>,
        now: DateTime<Utc>,
    ) -> DbResult<()> {
        let mut guard = self.conn().lock();
        let tx = guard.transaction()?;
        let existing: Option<(String, JsonColumn<Vec<String>>)> = tx
            .query_row(
                "SELECT g.id, g.scopes FROM device_grants dc \
                 JOIN grants g ON g.id = dc.id \
                 WHERE dc.client_id = ?1 AND dc.device_name = ?2",
                params![client_id, device_name],
                |row| Ok((row.get("id")?, row.get("scopes")?)),
            )
            .optional()?;
        if let Some((id, JsonColumn(merged))) = existing {
            let scopes_json = JsonColumn(union_scopes(merged, scopes));
            tx.execute(
                "UPDATE grants SET scopes = ?2, granted_at = ?3, patient = ?4 WHERE id = ?1",
                params![id, scopes_json, now, patient],
            )?;
        } else {
            let id = Uuid::new_v4().to_string();
            insert_parent(
                &tx,
                &id,
                client_id,
                scopes,
                patient,
                now,
                GrantType::DeviceCode,
            )?;
            insert_device_child(&tx, &id, client_id, device_name)?;
        }
        tx.commit()
    }

    /// Revoke a grant and expire the refresh-token families of its client in a
    /// single transaction, returning `true` if the grant existed. Doing both in
    /// one transaction means a partial failure can't leave the grant deleted
    /// while `offline_access` refresh tokens stay live (up to 90 days) —
    /// standing consent and standing credentials die together or not at all.
    /// Deleting the parent cascades to its child (`ON DELETE CASCADE`); families
    /// are expired in place (deadline pulled to `now`, live tokens stamped
    /// consumed), not deleted, so the lineage stays auditable.
    ///
    /// # Errors
    ///
    /// Returns a `rusqlite::Error` if opening the transaction, any statement, or
    /// the commit fails.
    pub fn revoke_grant_and_expire_client_families(
        &self,
        grant_id: &str,
        client_id: &str,
        now: DateTime<Utc>,
    ) -> DbResult<bool> {
        let mut guard = self.conn().lock();
        let tx = guard.transaction()?;
        let affected = tx.execute("DELETE FROM grants WHERE id = ?1", params![grant_id])?;
        tx.execute(
            "UPDATE refresh_tokens SET consumed_at = ?2
             WHERE consumed_at IS NULL AND family_id IN
                 (SELECT family_id FROM refresh_token_families WHERE client_id = ?1)",
            params![client_id, now],
        )?;
        tx.execute(
            "UPDATE refresh_token_families SET expires_at = ?2 WHERE client_id = ?1",
            params![client_id, now],
        )?;
        tx.commit()?;
        Ok(affected > 0)
    }
}

/// Union `additional` scopes into `merged`, preserving order and skipping
/// duplicates — consent is cumulative (approving a narrower request never
/// withdraws previously-consented scopes; revocation is the way to withdraw).
fn union_scopes(mut merged: Vec<String>, additional: &[String]) -> Vec<String> {
    for scope in additional {
        if !merged.contains(scope) {
            merged.push(scope.clone());
        }
    }
    merged
}

/// Insert a fresh parent `grants` row (`last_used_at` NULL) with the given
/// discriminator — shared by the insert arms of both upserts.
fn insert_parent(
    tx: &rusqlite::Transaction<'_>,
    id: &str,
    client_id: &str,
    scopes: &[String],
    patient: Option<&str>,
    now: DateTime<Utc>,
    grant_type: GrantType,
) -> DbResult<()> {
    let scopes_json = JsonColumn(scopes.to_vec());
    tx.execute(
        "INSERT INTO grants (id, client_id, scopes, granted_at, last_used_at, patient, grant_type) \
         VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6)",
        params![id, client_id, scopes_json, now, patient, grant_type],
    )?;
    Ok(())
}

/// Insert the authorization-code child row — the single write site for the
/// `authorization_code_grants` shape, shared by [`insert_child`] and
/// [`GatekeeperStore::upsert_grant`]'s insert arm.
fn insert_authorization_code_child(
    tx: &rusqlite::Transaction<'_>,
    id: &str,
    client_id: &str,
    redirect_uri: &Url,
) -> DbResult<()> {
    tx.execute(
        "INSERT INTO authorization_code_grants (id, client_id, redirect_uri) \
         VALUES (?1, ?2, ?3)",
        params![id, client_id, redirect_uri.as_str()],
    )?;
    Ok(())
}

/// Insert the device child row — the single write site for the `device_grants`
/// shape, shared by [`insert_child`] and
/// [`GatekeeperStore::upsert_device_grant`]'s insert arm.
fn insert_device_child(
    tx: &rusqlite::Transaction<'_>,
    id: &str,
    client_id: &str,
    device_name: &str,
) -> DbResult<()> {
    tx.execute(
        "INSERT INTO device_grants (id, client_id, device_name) VALUES (?1, ?2, ?3)",
        params![id, client_id, device_name],
    )?;
    Ok(())
}

/// Insert the child row a [`GrantKind`] implies — the write half of
/// parent-implies-child for [`GatekeeperStore::create_grant`].
fn insert_child(
    tx: &rusqlite::Transaction<'_>,
    id: &str,
    client_id: &str,
    kind: &GrantKind,
) -> DbResult<()> {
    match kind {
        GrantKind::AuthorizationCode { redirect_uri } => {
            insert_authorization_code_child(tx, id, client_id, redirect_uri)
        }
        GrantKind::DeviceCode { device_name } => {
            insert_device_child(tx, id, client_id, device_name)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::{arb_opt_timestamp, arb_timestamp, arb_url};
    use persistence_rust::{JsonColumn, UriColumn};
    use proptest::prelude::*;

    fn arb_kind() -> impl Strategy<Value = GrantKind> {
        prop_oneof![
            arb_url().prop_map(|url| GrantKind::AuthorizationCode {
                redirect_uri: UriColumn(url),
            }),
            "[ -~]{1,40}".prop_map(|device_name| GrantKind::DeviceCode { device_name }),
        ]
    }

    fn arb_grant() -> impl Strategy<Value = Grant> {
        (
            "[a-zA-Z0-9_-]{1,32}",
            "[a-zA-Z0-9_-]{1,32}",
            prop::collection::vec("[a-z][a-z0-9_]{0,15}", 0..5),
            arb_timestamp(),
            arb_opt_timestamp(),
            prop::option::of("[a-zA-Z0-9-]{1,32}"),
            arb_kind(),
        )
            .prop_map(
                |(id, client_id, scopes, granted_at, last_used_at, patient, kind)| Grant {
                    id,
                    client_id,
                    scopes: JsonColumn(scopes),
                    granted_at,
                    last_used_at,
                    patient,
                    kind,
                },
            )
    }

    fn read(url: &str) -> Url {
        Url::parse(url).expect("valid url")
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(48))]

        /// Both variants round-trip through the JOIN decoder: `create_grant`
        /// writes parent + child, and `grant_by_id` reconstructs the whole grant.
        #[test]
        fn create_and_fetch_round_trip(grant in arb_grant()) {
            let store = GatekeeperStore::open_in_memory().expect("open in-memory store");
            store.create_grant(&grant).expect("create");
            let fetched = store
                .grant_by_id(&grant.id)
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
        assert_eq!(&*grant.scopes, &["read".to_owned()]);
        assert_eq!(grant.patient.as_deref(), Some("pat-1"));
        assert!(matches!(grant.kind, GrantKind::AuthorizationCode { .. }));

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
        assert_eq!(&*updated.scopes, &["read".to_owned(), "write".to_owned()]);
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
        assert_eq!(&*grant.scopes, &["openid".to_owned()]);
        match &grant.kind {
            GrantKind::DeviceCode { device_name } => assert_eq!(device_name, "Ada's laptop"),
            other => panic!("expected a device grant, got {other:?}"),
        }

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
            &*updated.scopes,
            &["openid".to_owned(), "offline_access".to_owned()],
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

    /// A parent whose expected child row is gone (raw SQL tampering) is a typed
    /// read error naming the invariant, never a partial `Grant`.
    #[test]
    fn missing_child_row_is_a_typed_read_error() {
        let store = GatekeeperStore::open_in_memory().expect("open in-memory store");
        store
            .upsert_grant(
                "client-a",
                &read("https://example.com/cb"),
                &["read".to_owned()],
                None,
                Utc::now(),
            )
            .expect("insert");
        let id = store.all_grants().expect("list")[0].id.clone();
        // Drop the child directly (bypassing the cascade) to orphan the parent.
        store
            .conn()
            .lock()
            .execute(
                "DELETE FROM authorization_code_grants WHERE id = ?1",
                params![id],
            )
            .expect("delete child");
        let error = store
            .grant_by_id(&id)
            .expect_err("a code parent with no child must fail the read");
        assert!(
            error.to_string().contains("child row missing"),
            "error should name the invariant: {error}",
        );
    }

    /// Revoking deletes the parent and cascades to the child.
    #[test]
    fn revoke_cascades_to_the_child() {
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
        let id = store.all_grants().expect("list")[0].id.clone();

        assert!(store
            .revoke_grant_and_expire_client_families(&id, "client-a", Utc::now())
            .expect("revoke"));
        assert!(store.grant_by_id(&id).expect("query").is_none());
        let child_count: i64 = store
            .conn()
            .lock()
            .query_row(
                "SELECT COUNT(*) FROM device_grants WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .expect("count");
        assert_eq!(child_count, 0, "the child row is gone via CASCADE");
    }
}
