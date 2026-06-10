use rusqlite::{params, OptionalExtension, Row, ToSql};

use super::GatekeeperStore;
use crate::db_utils::sql_builder::build_insert_sql;
use crate::domain::authorization_code::AuthorizationCode;

fn make_named_sql_params(code: &AuthorizationCode) -> [(&str, &dyn ToSql); 9] {
    [
        (":code", &code.code),
        (":request_id", &code.request_id),
        (":client_id", &code.client_id),
        (":redirect_uri", &code.redirect_uri),
        (":code_challenge", &code.code_challenge),
        (":granted_scopes", &code.granted_scopes),
        (":patient", &code.patient),
        (":issued_at", &code.issued_at),
        (":expires_at", &code.expires_at),
    ]
}

impl TryFrom<&Row<'_>> for AuthorizationCode {
    type Error = rusqlite::Error;
    fn try_from(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(AuthorizationCode {
            code: row.get("code")?,
            request_id: row.get("request_id")?,
            client_id: row.get("client_id")?,
            redirect_uri: row.get("redirect_uri")?,
            code_challenge: row.get("code_challenge")?,
            granted_scopes: row.get("granted_scopes")?,
            patient: row.get("patient")?,
            issued_at: row.get("issued_at")?,
            expires_at: row.get("expires_at")?,
        })
    }
}

const ALL_COLS: &str =
    "code, request_id, client_id, redirect_uri, code_challenge, granted_scopes, patient, issued_at, expires_at";

impl GatekeeperStore {
    /// Atomically read-and-delete the authorization code so a `/token`
    /// redemption either gets the row exactly once or sees `None`. Wins the
    /// RFC 6749 §10.5 single-use race against any concurrent redeemer of the
    /// same code — `DELETE ... RETURNING` runs under SQLite's write lock, so
    /// only one caller's `Ok(Some)` lands and any racer sees `Ok(None)`.
    pub fn redeem_authorization_code(
        &self,
        code: &str,
    ) -> crate::db::DbResult<Option<AuthorizationCode>> {
        self.conn()
            .lock()
            .query_row(
                &format!("DELETE FROM authorization_codes WHERE code = ?1 RETURNING {ALL_COLS}"),
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
                &format!("SELECT {ALL_COLS} FROM authorization_codes WHERE request_id = ?1"),
                params![request_id],
                |row| AuthorizationCode::try_from(row),
            )
            .optional()
    }

    /// Persist a freshly-minted authorization code.
    pub fn issue_authorization_code(&self, code: &AuthorizationCode) -> crate::db::DbResult<()> {
        let params = make_named_sql_params(code);
        self.conn().lock().execute(
            &build_insert_sql("authorization_codes", &params),
            &params,
        )?;
        Ok(())
    }
}
