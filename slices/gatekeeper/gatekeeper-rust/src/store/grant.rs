use rusqlite::{params, OptionalExtension, Row};
use serde::Serialize;

use super::GatekeeperStore;

#[derive(Debug, Clone, Serialize)]
pub struct GrantRow {
    pub id: String,
    #[serde(rename = "clientId")]
    pub client_id: String,
    pub scopes: Vec<String>,
    #[serde(rename = "redirectUri")]
    pub redirect_uri: String,
    #[serde(rename = "grantedAt")]
    pub granted_at: String,
    #[serde(rename = "lastUsedAt")]
    pub last_used_at: Option<String>,
    pub patient: Option<String>,
}

fn row_to_grant(row: &Row) -> rusqlite::Result<GrantRow> {
    let scopes_json: String = row.get("scopes")?;
    Ok(GrantRow {
        id: row.get("id")?,
        client_id: row.get("clientId")?,
        scopes: serde_json::from_str(&scopes_json).map_err(|_| rusqlite::Error::InvalidQuery)?,
        redirect_uri: row.get("redirectUri")?,
        granted_at: row.get("grantedAt")?,
        last_used_at: row.get("lastUsedAt")?,
        patient: row.get("patient")?,
    })
}

const ALL_COLS: &str = "id, clientId, scopes, redirectUri, grantedAt, lastUsedAt, patient";

impl GatekeeperStore {
    pub fn all_grants(&self) -> crate::store::DbResult<Vec<GrantRow>> {
        let conn = self.conn().lock();
        let mut stmt =
            conn.prepare(&format!("SELECT {ALL_COLS} FROM grants ORDER BY grantedAt"))?;
        let rows = stmt
            .query_map([], row_to_grant)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn grant_by_id(&self, id: &str) -> crate::store::DbResult<Option<GrantRow>> {
        self.conn()
            .lock()
            .query_row(
                &format!("SELECT {ALL_COLS} FROM grants WHERE id = ?1"),
                params![id],
                row_to_grant,
            )
            .optional()
    }

    pub fn grant_by_client_and_redirect(
        &self,
        client_id: &str,
        redirect_uri: &str,
    ) -> crate::store::DbResult<Option<GrantRow>> {
        self.conn()
            .lock()
            .query_row(
                &format!(
                    "SELECT {ALL_COLS} FROM grants WHERE clientId = ?1 AND redirectUri = ?2"
                ),
                params![client_id, redirect_uri],
                row_to_grant,
            )
            .optional()
    }

    pub fn create_grant(&self, row: GrantRow) -> crate::store::DbResult<()> {
        let scopes = serde_json::to_string(&row.scopes).unwrap();
        self.conn().lock().execute(
            "INSERT INTO grants (id, clientId, scopes, redirectUri, grantedAt, lastUsedAt, patient)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                row.id,
                row.client_id,
                scopes,
                row.redirect_uri,
                row.granted_at,
                row.last_used_at,
                row.patient,
            ],
        )?;
        Ok(())
    }

    pub fn update_grant(
        &self,
        id: &str,
        scopes: &[String],
        granted_at: &str,
        patient: Option<&str>,
    ) -> crate::store::DbResult<()> {
        let scopes_json = serde_json::to_string(scopes).unwrap();
        self.conn().lock().execute(
            "UPDATE grants SET scopes = ?2, grantedAt = ?3, patient = ?4 WHERE id = ?1",
            params![id, scopes_json, granted_at, patient],
        )?;
        Ok(())
    }

    pub fn revoke_grant(&self, id: &str) -> crate::store::DbResult<bool> {
        let affected = self
            .conn()
            .lock()
            .execute("DELETE FROM grants WHERE id = ?1", params![id])?;
        Ok(affected > 0)
    }
}
