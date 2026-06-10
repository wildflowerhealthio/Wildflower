use chrono::{DateTime, Utc};
use rusqlite::{params, OptionalExtension, Row, ToSql};
use url::Url;

use super::GatekeeperStore;
use crate::db_utils::sql_builder::build_insert_sql;
use crate::db_utils::JsonColumn;
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
    pub fn all_grants(&self) -> crate::db::DbResult<Vec<Grant>> {
        let conn = self.conn().lock();
        let mut stmt = conn.prepare(&format!(
            "SELECT {ALL_COLS} FROM grants ORDER BY granted_at"
        ))?;
        let rows: rusqlite::Result<Vec<_>> =
            stmt.query_map([], |row| Grant::try_from(row))?.collect();
        rows
    }

    /// Load a single grant by primary id.
    pub fn grant_by_id(&self, id: &str) -> crate::db::DbResult<Option<Grant>> {
        self.conn()
            .lock()
            .query_row(
                &format!("SELECT {ALL_COLS} FROM grants WHERE id = ?1"),
                params![id],
                |row| Grant::try_from(row),
            )
            .optional()
    }

    /// Find an existing grant for the (client_id, redirect_uri) pair so
    /// `/authorize` can decide whether to short-circuit the consent prompt.
    pub fn grant_by_client_and_redirect(
        &self,
        client_id: &str,
        redirect_uri: &Url,
    ) -> crate::db::DbResult<Option<Grant>> {
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
    pub fn create_grant(&self, grant: &Grant) -> crate::db::DbResult<()> {
        let params = make_named_sql_params(grant);
        self.conn()
            .lock()
            .execute(
                &build_insert_sql("grants", &params),
                &params,
            )?;
        Ok(())
    }

    /// Replace an existing grant's scopes (and patient context) on
    /// re-approval, bumping `granted_at` to `now`.
    pub fn update_grant(
        &self,
        id: &str,
        scopes: &[String],
        granted_at: DateTime<Utc>,
        patient: Option<&str>,
    ) -> crate::db::DbResult<()> {
        let scopes_json = JsonColumn(scopes.to_vec());
        self.conn().lock().execute(
            "UPDATE grants SET scopes = ?2, granted_at = ?3, patient = ?4 WHERE id = ?1",
            params![id, scopes_json, granted_at, patient],
        )?;
        Ok(())
    }

    /// Delete a grant; returns `true` if a row was actually removed so the
    /// caller can distinguish "revoked" from "no such grant".
    pub fn revoke_grant(&self, id: &str) -> crate::db::DbResult<bool> {
        let affected = self
            .conn()
            .lock()
            .execute("DELETE FROM grants WHERE id = ?1", params![id])?;
        Ok(affected > 0)
    }
}
