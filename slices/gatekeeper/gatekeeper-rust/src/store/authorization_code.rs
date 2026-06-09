use chrono::{DateTime, Utc};
use rusqlite::{params, OptionalExtension, Row, ToSql};

use super::types::Json;
use super::GatekeeperStore;

#[derive(Debug, Clone)]
pub struct AuthorizationCode {
    pub code: String,
    pub request_id: String,
    pub client_id: String,
    pub redirect_uri: String,
    pub code_challenge: String,
    pub granted_scopes: Json<Vec<String>>,
    pub patient: Option<String>,
    pub issued_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

impl AuthorizationCode {
    pub fn as_named_sql_params(&self) -> [(&str, &dyn ToSql); 9] {
        [
            (":code", &self.code),
            (":requestId", &self.request_id),
            (":clientId", &self.client_id),
            (":redirectUri", &self.redirect_uri),
            (":codeChallenge", &self.code_challenge),
            (":grantedScopes", &self.granted_scopes),
            (":patient", &self.patient),
            (":issuedAt", &self.issued_at),
            (":expiresAt", &self.expires_at),
        ]
    }
}

impl TryFrom<&Row<'_>> for AuthorizationCode {
    type Error = rusqlite::Error;
    fn try_from(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(AuthorizationCode {
            code: row.get("code")?,
            request_id: row.get("requestId")?,
            client_id: row.get("clientId")?,
            redirect_uri: row.get("redirectUri")?,
            code_challenge: row.get("codeChallenge")?,
            granted_scopes: row.get("grantedScopes")?,
            patient: row.get("patient")?,
            issued_at: row.get("issuedAt")?,
            expires_at: row.get("expiresAt")?,
        })
    }
}

const ALL_COLS: &str =
    "code, requestId, clientId, redirectUri, codeChallenge, grantedScopes, patient, issuedAt, expiresAt";

impl GatekeeperStore {
    pub fn authorization_code_by_code(
        &self,
        code: &str,
    ) -> crate::store::DbResult<Option<AuthorizationCode>> {
        self.conn()
            .lock()
            .query_row(
                &format!("SELECT {ALL_COLS} FROM authorizationCodes WHERE code = ?1"),
                params![code],
                |row| AuthorizationCode::try_from(row),
            )
            .optional()
    }

    pub fn authorization_code_by_request_id(
        &self,
        request_id: &str,
    ) -> crate::store::DbResult<Option<AuthorizationCode>> {
        self.conn()
            .lock()
            .query_row(
                &format!("SELECT {ALL_COLS} FROM authorizationCodes WHERE requestId = ?1"),
                params![request_id],
                |row| AuthorizationCode::try_from(row),
            )
            .optional()
    }

    pub fn issue_authorization_code(&self, code: &AuthorizationCode) -> crate::store::DbResult<()> {
        self.conn().lock().execute(
            "INSERT INTO authorizationCodes
             (code, requestId, clientId, redirectUri, codeChallenge, grantedScopes, patient, issuedAt, expiresAt)
             VALUES (:code, :requestId, :clientId, :redirectUri, :codeChallenge, :grantedScopes, :patient, :issuedAt, :expiresAt)",
            &code.as_named_sql_params(),
        )?;
        Ok(())
    }

    pub fn consume_authorization_code(&self, code: &str) -> crate::store::DbResult<()> {
        self.conn().lock().execute(
            "DELETE FROM authorizationCodes WHERE code = ?1",
            params![code],
        )?;
        Ok(())
    }
}
