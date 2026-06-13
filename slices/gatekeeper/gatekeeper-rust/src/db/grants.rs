use chrono::{DateTime, Utc};
use rusqlite::{params, OptionalExtension, Row, ToSql};
use url::Url;

use uuid::Uuid;

use crate::db_utils::sql_builder::build_insert_sql;
use crate::db_utils::{DbResult, GatekeeperStore, JsonColumn, UriColumn};
use crate::domain::grant::Grant;

fn make_named_sql_params(grant: &Grant) -> [(&str, &dyn ToSql); 7] {
    [
        (":id", &grant.id),
        (":client_id", &grant.client_id),
        (":scopes", &grant.scopes),
        (":redirect_uri", &grant.redirect_uri),
        (":granted_at", &grant.granted_at),
        (":last_used_at", &grant.last_used_at),
        (":patient", &grant.patient),
    ]
}

impl TryFrom<&Row<'_>> for Grant {
    type Error = rusqlite::Error;
    fn try_from(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Grant {
            id: row.get("id")?,
            client_id: row.get("client_id")?,
            scopes: row.get("scopes")?,
            redirect_uri: row.get("redirect_uri")?,
            granted_at: row.get("granted_at")?,
            last_used_at: row.get("last_used_at")?,
            patient: row.get("patient")?,
        })
    }
}

const ALL_COLS: &str = "id, client_id, scopes, redirect_uri, granted_at, last_used_at, patient";

impl GatekeeperStore {
    /// All grants in `granted_at` order — backs the Owner UI's grant list page.
    ///
    /// # Errors
    ///
    /// Returns a `rusqlite::Error` if preparing or running the select query fails
    /// or any returned row cannot be mapped to a [`Grant`].
    pub fn all_grants(&self) -> DbResult<Vec<Grant>> {
        let conn = self.conn().lock();
        let mut stmt = conn.prepare(&format!(
            "SELECT {ALL_COLS} FROM grants ORDER BY granted_at"
        ))?;
        let rows: rusqlite::Result<Vec<_>> =
            stmt.query_map([], |row| Grant::try_from(row))?.collect();
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
                &format!("SELECT {ALL_COLS} FROM grants WHERE id = ?1"),
                params![id],
                |row| Grant::try_from(row),
            )
            .optional()
    }

    /// Find an existing grant for the (`client_id`, `redirect_uri`) pair so
    /// `/authorize` can decide whether to short-circuit the consent prompt.
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
                &format!(
                    "SELECT {ALL_COLS} FROM grants WHERE client_id = ?1 AND redirect_uri = ?2"
                ),
                params![client_id, redirect_uri.as_str()],
                |row| Grant::try_from(row),
            )
            .optional()
    }

    /// Insert a brand-new grant row.
    ///
    /// # Errors
    ///
    /// Returns a `rusqlite::Error` if the insert fails (for example a
    /// unique-constraint violation on the id).
    pub fn create_grant(&self, grant: &Grant) -> DbResult<()> {
        let params = make_named_sql_params(grant);
        self.conn()
            .lock()
            .execute(&build_insert_sql("grants", &params), &params)?;
        Ok(())
    }

    /// Replace an existing grant's scopes (and patient context) on
    /// re-approval, bumping `granted_at` to `now`.
    ///
    /// # Errors
    ///
    /// Returns a `rusqlite::Error` if the update statement fails.
    pub fn update_grant(
        &self,
        id: &str,
        scopes: &[String],
        granted_at: DateTime<Utc>,
        patient: Option<&str>,
    ) -> DbResult<()> {
        let scopes_json = JsonColumn(scopes.to_vec());
        self.conn().lock().execute(
            "UPDATE grants SET scopes = ?2, granted_at = ?3, patient = ?4 WHERE id = ?1",
            params![id, scopes_json, granted_at, patient],
        )?;
        Ok(())
    }

    /// Delete a grant; returns `true` if a row was actually removed so the
    /// caller can distinguish "revoked" from "no such grant".
    ///
    /// # Errors
    ///
    /// Returns a `rusqlite::Error` if the delete statement fails.
    pub fn revoke_grant(&self, id: &str) -> DbResult<bool> {
        let affected = self
            .conn()
            .lock()
            .execute("DELETE FROM grants WHERE id = ?1", params![id])?;
        Ok(affected > 0)
    }

    /// Revoke a grant and expire the refresh-token families of its client in a
    /// single transaction, returning `true` if the grant existed. Doing both in
    /// one transaction means a partial failure can't leave the grant deleted
    /// while `offline_access` refresh tokens stay live (up to 90 days) —
    /// standing consent and standing credentials die together or not at all.
    /// Families are expired in place (deadline pulled to `now`, live tokens
    /// stamped consumed), not deleted, so the lineage stays auditable.
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

    /// Insert or update the standing grant for `(client_id, redirect_uri)` in a
    /// single transaction. Consent is cumulative: an existing grant's scopes
    /// are unioned with `scopes` (approving a narrower request never withdraws
    /// previously-consented scopes — revocation is the way to withdraw), and
    /// `granted_at`/`patient` are refreshed. Doing the read-merge-write under
    /// one transaction (paired with the UNIQUE index on the pair) means two
    /// concurrent approvals can't both insert a duplicate grant.
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
                "SELECT id, scopes FROM grants WHERE client_id = ?1 AND redirect_uri = ?2",
                params![client_id, redirect_uri.as_str()],
                |row| Ok((row.get("id")?, row.get("scopes")?)),
            )
            .optional()?;
        match existing {
            Some((id, JsonColumn(mut merged))) => {
                for scope in scopes {
                    if !merged.contains(scope) {
                        merged.push(scope.clone());
                    }
                }
                let scopes_json = JsonColumn(merged);
                tx.execute(
                    "UPDATE grants SET scopes = ?2, granted_at = ?3, patient = ?4 WHERE id = ?1",
                    params![id, scopes_json, now, patient],
                )?;
            }
            None => {
                let grant = Grant {
                    id: Uuid::new_v4().to_string(),
                    client_id: client_id.to_string(),
                    scopes: JsonColumn(scopes.to_vec()),
                    redirect_uri: UriColumn(redirect_uri.clone()),
                    granted_at: now,
                    last_used_at: None,
                    patient: patient.map(str::to_string),
                };
                let params = make_named_sql_params(&grant);
                tx.execute(&build_insert_sql("grants", &params), &params)?;
            }
        }
        tx.commit()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::{arb_opt_timestamp, arb_timestamp, arb_url};
    use crate::db_utils::{JsonColumn, UriColumn};
    use proptest::prelude::*;

    fn arb_grant() -> impl Strategy<Value = Grant> {
        (
            "[a-zA-Z0-9_-]{1,32}",
            "[a-zA-Z0-9_-]{1,32}",
            prop::collection::vec("[a-z][a-z0-9_]{0,15}", 0..5),
            arb_url(),
            arb_timestamp(),
            arb_opt_timestamp(),
            prop::option::of("[a-zA-Z0-9-]{1,32}"),
        )
            .prop_map(
                |(id, client_id, scopes, redirect_uri, granted_at, last_used_at, patient)| Grant {
                    id,
                    client_id,
                    scopes: JsonColumn(scopes),
                    redirect_uri: UriColumn(redirect_uri),
                    granted_at,
                    last_used_at,
                    patient,
                },
            )
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(48))]

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
}
