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
    pub async fn all_grants(&self) -> crate::store::DbResult<Vec<GrantRow>> {
        self.conn()
            .call(|c| {
                let mut stmt =
                    c.prepare(&format!("SELECT {ALL_COLS} FROM grants ORDER BY grantedAt"))?;
                let rows = stmt
                    .query_map([], row_to_grant)?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })
            .await
    }

    pub async fn grant_by_id(&self, id: &str) -> crate::store::DbResult<Option<GrantRow>> {
        let id = id.to_string();
        self.conn()
            .call(move |c| {
                let row = c
                    .query_row(
                        &format!("SELECT {ALL_COLS} FROM grants WHERE id = ?1"),
                        params![id],
                        row_to_grant,
                    )
                    .optional()?;
                Ok(row)
            })
            .await
    }

    pub async fn grant_by_client_and_redirect(
        &self,
        client_id: &str,
        redirect_uri: &str,
    ) -> crate::store::DbResult<Option<GrantRow>> {
        let cid = client_id.to_string();
        let ru = redirect_uri.to_string();
        self.conn()
            .call(move |c| {
                let row = c
                    .query_row(
                        &format!(
                            "SELECT {ALL_COLS} FROM grants WHERE clientId = ?1 AND redirectUri = ?2"
                        ),
                        params![cid, ru],
                        row_to_grant,
                    )
                    .optional()?;
                Ok(row)
            })
            .await
    }

    pub async fn create_grant(&self, row: GrantRow) -> crate::store::DbResult<()> {
        self.conn()
            .call(move |c| {
                let scopes = serde_json::to_string(&row.scopes).unwrap();
                c.execute(
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
            })
            .await
    }

    pub async fn update_grant(
        &self,
        id: &str,
        scopes: &[String],
        granted_at: &str,
        patient: Option<&str>,
    ) -> crate::store::DbResult<()> {
        let id = id.to_string();
        let scopes_json = serde_json::to_string(scopes).unwrap();
        let granted_at = granted_at.to_string();
        let patient = patient.map(str::to_string);
        self.conn()
            .call(move |c| {
                c.execute(
                    "UPDATE grants SET scopes = ?2, grantedAt = ?3, patient = ?4 WHERE id = ?1",
                    params![id, scopes_json, granted_at, patient],
                )?;
                Ok(())
            })
            .await
    }

    pub async fn revoke_grant(&self, id: &str) -> crate::store::DbResult<bool> {
        let id = id.to_string();
        self.conn()
            .call(move |c| {
                let affected = c.execute("DELETE FROM grants WHERE id = ?1", params![id])?;
                Ok(affected > 0)
            })
            .await
    }
}
