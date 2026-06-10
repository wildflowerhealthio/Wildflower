use rusqlite::{params, OptionalExtension, Row, ToSql};

use super::GatekeeperStore;
use crate::domain::authorization_code::AuthorizationCode;

impl AuthorizationCode {
    pub(in crate::db) fn as_named_sql_params(&self) -> [(&str, &dyn ToSql); 9] {
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
    /// Look up an authorization code at `/token` redemption time.
    pub fn authorization_code_by_code(
        &self,
        code: &str,
    ) -> crate::db::DbResult<Option<AuthorizationCode>> {
        self.conn()
            .lock()
            .query_row(
                &format!("SELECT {ALL_COLS} FROM authorizationCodes WHERE code = ?1"),
                params![code],
                |row| AuthorizationCode::try_from(row),
            )
            .optional()
    }

    /// Look up the code that was issued for a given `request_id`, used by the
    /// Owner UI's polling endpoint to build the final redirect URL.
    pub fn authorization_code_by_request_id(
        &self,
        request_id: &str,
    ) -> crate::db::DbResult<Option<AuthorizationCode>> {
        self.conn()
            .lock()
            .query_row(
                &format!("SELECT {ALL_COLS} FROM authorizationCodes WHERE requestId = ?1"),
                params![request_id],
                |row| AuthorizationCode::try_from(row),
            )
            .optional()
    }

    /// Persist a freshly-minted authorization code.
    pub fn issue_authorization_code(&self, code: &AuthorizationCode) -> crate::db::DbResult<()> {
        self.conn().lock().execute(
            "INSERT INTO authorizationCodes
             (code, requestId, clientId, redirectUri, codeChallenge, grantedScopes, patient, issuedAt, expiresAt)
             VALUES (:code, :requestId, :clientId, :redirectUri, :codeChallenge, :grantedScopes, :patient, :issuedAt, :expiresAt)",
            &code.as_named_sql_params(),
        )?;
        Ok(())
    }

    /// Delete a code at `/token` redemption time. Called whether the
    /// redemption succeeded or failed — codes are single-use either way (RFC
    /// 6749 §10.5 replay protection).
    pub fn consume_authorization_code(&self, code: &str) -> crate::db::DbResult<()> {
        self.conn().lock().execute(
            "DELETE FROM authorizationCodes WHERE code = ?1",
            params![code],
        )?;
        Ok(())
    }
}
