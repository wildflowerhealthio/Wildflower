use chrono::{DateTime, Utc};
use rusqlite::{params, OptionalExtension, Row, ToSql};
use serde::Serialize;

use super::types::Json;
use super::GatekeeperStore;

/// A previously-approved consent — when the same (client, redirect_uri) pair
/// re-authorizes, the gatekeeper can skip the consent prompt for any scopes
/// already in `scopes`.
#[derive(Debug, Clone, Serialize)]
pub struct Grant {
    pub id: String,
    #[serde(rename = "clientId")]
    pub client_id: String,
    pub scopes: Json<Vec<String>>,
    #[serde(rename = "redirectUri")]
    pub redirect_uri: String,
    #[serde(rename = "grantedAt")]
    pub granted_at: DateTime<Utc>,
    #[serde(rename = "lastUsedAt")]
    pub last_used_at: Option<DateTime<Utc>>,
    pub patient: Option<String>,
}

impl Grant {
    pub fn as_named_sql_params(&self) -> [(&str, &dyn ToSql); 7] {
        [
            (":id", &self.id),
            (":clientId", &self.client_id),
            (":scopes", &self.scopes),
            (":redirectUri", &self.redirect_uri),
            (":grantedAt", &self.granted_at),
            (":lastUsedAt", &self.last_used_at),
            (":patient", &self.patient),
        ]
    }
}

impl TryFrom<&Row<'_>> for Grant {
    type Error = rusqlite::Error;
    fn try_from(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Grant {
            id: row.get("id")?,
            client_id: row.get("clientId")?,
            scopes: row.get("scopes")?,
            redirect_uri: row.get("redirectUri")?,
            granted_at: row.get("grantedAt")?,
            last_used_at: row.get("lastUsedAt")?,
            patient: row.get("patient")?,
        })
    }
}

const ALL_COLS: &str = "id, clientId, scopes, redirectUri, grantedAt, lastUsedAt, patient";

impl GatekeeperStore {
    /// All grants in `grantedAt` order — backs the Owner UI's grant list page.
    pub fn all_grants(&self) -> crate::store::DbResult<Vec<Grant>> {
        let conn = self.conn().lock();
        let mut stmt =
            conn.prepare(&format!("SELECT {ALL_COLS} FROM grants ORDER BY grantedAt"))?;
        let rows: rusqlite::Result<Vec<_>> = stmt
            .query_map([], |row| Grant::try_from(row))?
            .collect();
        rows
    }

    /// Load a single grant by primary id.
    pub fn grant_by_id(&self, id: &str) -> crate::store::DbResult<Option<Grant>> {
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
        redirect_uri: &str,
    ) -> crate::store::DbResult<Option<Grant>> {
        self.conn()
            .lock()
            .query_row(
                &format!(
                    "SELECT {ALL_COLS} FROM grants WHERE clientId = ?1 AND redirectUri = ?2"
                ),
                params![client_id, redirect_uri],
                |row| Grant::try_from(row),
            )
            .optional()
    }

    /// Insert a brand-new grant row.
    pub fn create_grant(&self, grant: &Grant) -> crate::store::DbResult<()> {
        self.conn().lock().execute(
            "INSERT INTO grants (id, clientId, scopes, redirectUri, grantedAt, lastUsedAt, patient)
             VALUES (:id, :clientId, :scopes, :redirectUri, :grantedAt, :lastUsedAt, :patient)",
            &grant.as_named_sql_params(),
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
    ) -> crate::store::DbResult<()> {
        let scopes_json = Json(scopes.to_vec());
        self.conn().lock().execute(
            "UPDATE grants SET scopes = ?2, grantedAt = ?3, patient = ?4 WHERE id = ?1",
            params![id, scopes_json, granted_at, patient],
        )?;
        Ok(())
    }

    /// Delete a grant; returns `true` if a row was actually removed so the
    /// caller can distinguish "revoked" from "no such grant".
    pub fn revoke_grant(&self, id: &str) -> crate::store::DbResult<bool> {
        let affected = self
            .conn()
            .lock()
            .execute("DELETE FROM grants WHERE id = ?1", params![id])?;
        Ok(affected > 0)
    }
}
