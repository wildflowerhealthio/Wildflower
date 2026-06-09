use rusqlite::{params, OptionalExtension, Row};

use super::GatekeeperStore;

#[derive(Debug, Clone)]
pub struct AuthorizationCodeRow {
    pub code: String,
    pub request_id: String,
    pub client_id: String,
    pub redirect_uri: String,
    pub code_challenge: String,
    pub granted_scopes: Vec<String>,
    pub patient: Option<String>,
    pub issued_at: String,
    pub expires_at: String,
}

fn row_to_code(row: &Row) -> rusqlite::Result<AuthorizationCodeRow> {
    let granted_scopes_json: String = row.get("grantedScopes")?;
    Ok(AuthorizationCodeRow {
        code: row.get("code")?,
        request_id: row.get("requestId")?,
        client_id: row.get("clientId")?,
        redirect_uri: row.get("redirectUri")?,
        code_challenge: row.get("codeChallenge")?,
        granted_scopes: serde_json::from_str(&granted_scopes_json)
            .map_err(|_| rusqlite::Error::InvalidQuery)?,
        patient: row.get("patient")?,
        issued_at: row.get("issuedAt")?,
        expires_at: row.get("expiresAt")?,
    })
}

const ALL_COLS: &str =
    "code, requestId, clientId, redirectUri, codeChallenge, grantedScopes, patient, issuedAt, expiresAt";

impl GatekeeperStore {
    pub async fn authorization_code_by_code(
        &self,
        code: &str,
    ) -> crate::store::DbResult<Option<AuthorizationCodeRow>> {
        let code = code.to_string();
        self.conn()
            .call(move |c| {
                let row = c
                    .query_row(
                        &format!("SELECT {ALL_COLS} FROM authorizationCodes WHERE code = ?1"),
                        params![code],
                        row_to_code,
                    )
                    .optional()?;
                Ok(row)
            })
            .await
    }

    pub async fn authorization_code_by_request_id(
        &self,
        request_id: &str,
    ) -> crate::store::DbResult<Option<AuthorizationCodeRow>> {
        let rid = request_id.to_string();
        self.conn()
            .call(move |c| {
                let row = c
                    .query_row(
                        &format!("SELECT {ALL_COLS} FROM authorizationCodes WHERE requestId = ?1"),
                        params![rid],
                        row_to_code,
                    )
                    .optional()?;
                Ok(row)
            })
            .await
    }

    pub async fn issue_authorization_code(
        &self,
        row: AuthorizationCodeRow,
    ) -> crate::store::DbResult<()> {
        self.conn()
            .call(move |c| {
                let scopes = serde_json::to_string(&row.granted_scopes).unwrap();
                c.execute(
                    "INSERT INTO authorizationCodes
                     (code, requestId, clientId, redirectUri, codeChallenge, grantedScopes, patient, issuedAt, expiresAt)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                    params![
                        row.code,
                        row.request_id,
                        row.client_id,
                        row.redirect_uri,
                        row.code_challenge,
                        scopes,
                        row.patient,
                        row.issued_at,
                        row.expires_at,
                    ],
                )?;
                Ok(())
            })
            .await
    }

    pub async fn consume_authorization_code(&self, code: &str) -> crate::store::DbResult<()> {
        let code = code.to_string();
        self.conn()
            .call(move |c| {
                c.execute(
                    "DELETE FROM authorizationCodes WHERE code = ?1",
                    params![code],
                )?;
                Ok(())
            })
            .await
    }
}
