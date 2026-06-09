use rusqlite::{params, OptionalExtension, Row};

use super::GatekeeperStore;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GrantType {
    AuthorizationCode,
    DeviceCode,
}

impl GrantType {
    pub fn as_str(&self) -> &'static str {
        match self {
            GrantType::AuthorizationCode => "authorization_code",
            GrantType::DeviceCode => "device_code",
        }
    }
    pub fn parse(s: &str) -> Option<GrantType> {
        match s {
            "authorization_code" => Some(GrantType::AuthorizationCode),
            "device_code" => Some(GrantType::DeviceCode),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestStatus {
    Pending,
    Approved,
    Denied,
    Expired,
}

impl RequestStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            RequestStatus::Pending => "pending",
            RequestStatus::Approved => "approved",
            RequestStatus::Denied => "denied",
            RequestStatus::Expired => "expired",
        }
    }
    pub fn parse(s: &str) -> Option<RequestStatus> {
        match s {
            "pending" => Some(RequestStatus::Pending),
            "approved" => Some(RequestStatus::Approved),
            "denied" => Some(RequestStatus::Denied),
            "expired" => Some(RequestStatus::Expired),
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct AuthorizationRequestRow {
    pub id: String,
    pub grant_type: GrantType,
    pub client_id: String,
    pub requested_scopes: Vec<String>,
    pub code_challenge: Option<String>,
    pub code_challenge_method: Option<String>,
    pub redirect_uri: Option<String>,
    pub client_state: Option<String>,
    pub user_code: Option<String>,
    pub pre_approved_scopes: Option<Vec<String>>,
    pub requested_at: String,
    pub expires_at: String,
    pub last_polled_at: Option<String>,
    pub status: RequestStatus,
    pub granted_scopes: Option<Vec<String>>,
    pub patient: Option<String>,
}

fn row_to_request(row: &Row) -> rusqlite::Result<AuthorizationRequestRow> {
    let grant_type_str: String = row.get("grantType")?;
    let requested_scopes_json: String = row.get("requestedScopes")?;
    let pre_approved_scopes_json: Option<String> = row.get("preApprovedScopes")?;
    let granted_scopes_json: Option<String> = row.get("grantedScopes")?;
    let status_str: String = row.get("status")?;
    Ok(AuthorizationRequestRow {
        id: row.get("id")?,
        grant_type: GrantType::parse(&grant_type_str).ok_or(rusqlite::Error::InvalidQuery)?,
        client_id: row.get("clientId")?,
        requested_scopes: serde_json::from_str(&requested_scopes_json)
            .map_err(|_| rusqlite::Error::InvalidQuery)?,
        code_challenge: row.get("codeChallenge")?,
        code_challenge_method: row.get("codeChallengeMethod")?,
        redirect_uri: row.get("redirectUri")?,
        client_state: row.get("clientState")?,
        user_code: row.get("userCode")?,
        pre_approved_scopes: match pre_approved_scopes_json {
            Some(s) => Some(serde_json::from_str(&s).map_err(|_| rusqlite::Error::InvalidQuery)?),
            None => None,
        },
        requested_at: row.get("requestedAt")?,
        expires_at: row.get("expiresAt")?,
        last_polled_at: row.get("lastPolledAt")?,
        status: RequestStatus::parse(&status_str).ok_or(rusqlite::Error::InvalidQuery)?,
        granted_scopes: match granted_scopes_json {
            Some(s) => Some(serde_json::from_str(&s).map_err(|_| rusqlite::Error::InvalidQuery)?),
            None => None,
        },
        patient: row.get("patient")?,
    })
}

const ALL_COLS: &str =
    "id, grantType, clientId, requestedScopes, codeChallenge, codeChallengeMethod, redirectUri, \
     clientState, userCode, preApprovedScopes, requestedAt, expiresAt, lastPolledAt, status, \
     grantedScopes, patient";

impl GatekeeperStore {
    pub fn authorization_request_by_id(
        &self,
        id: &str,
    ) -> crate::store::DbResult<Option<AuthorizationRequestRow>> {
        self.conn()
            .lock()
            .query_row(
                &format!("SELECT {ALL_COLS} FROM authorizationRequests WHERE id = ?1"),
                params![id],
                row_to_request,
            )
            .optional()
    }

    pub fn authorization_request_by_user_code(
        &self,
        user_code: &str,
    ) -> crate::store::DbResult<Option<AuthorizationRequestRow>> {
        self.conn()
            .lock()
            .query_row(
                &format!("SELECT {ALL_COLS} FROM authorizationRequests WHERE userCode = ?1"),
                params![user_code],
                row_to_request,
            )
            .optional()
    }

    pub fn start_code_authorization_request(
        &self,
        input: StartCodeRequest,
    ) -> crate::store::DbResult<()> {
        let requested_scopes = serde_json::to_string(&input.requested_scopes).unwrap();
        let pre_approved_scopes = input
            .pre_approved_scopes
            .as_ref()
            .map(|v| serde_json::to_string(v).unwrap());
        self.conn().lock().execute(
            "INSERT INTO authorizationRequests
             (id, grantType, clientId, requestedScopes, codeChallenge, codeChallengeMethod,
              redirectUri, clientState, userCode, preApprovedScopes, requestedAt, expiresAt,
              lastPolledAt, status, grantedScopes, patient)
             VALUES (?1, 'authorization_code', ?2, ?3, ?4, 'S256', ?5, ?6, NULL, ?7, ?8, ?9,
                     NULL, 'pending', NULL, NULL)",
            params![
                input.request_id,
                input.client_id,
                requested_scopes,
                input.code_challenge,
                input.redirect_uri,
                input.client_state,
                pre_approved_scopes,
                input.requested_at,
                input.expires_at,
            ],
        )?;
        Ok(())
    }

    pub fn start_device_authorization_request(
        &self,
        input: StartDeviceRequest,
    ) -> crate::store::DbResult<()> {
        let requested_scopes = serde_json::to_string(&input.requested_scopes).unwrap();
        self.conn().lock().execute(
            "INSERT INTO authorizationRequests
             (id, grantType, clientId, requestedScopes, codeChallenge, codeChallengeMethod,
              redirectUri, clientState, userCode, preApprovedScopes, requestedAt, expiresAt,
              lastPolledAt, status, grantedScopes, patient)
             VALUES (?1, 'device_code', ?2, ?3, NULL, NULL, NULL, NULL, ?4, NULL, ?5, ?6,
                     NULL, 'pending', NULL, NULL)",
            params![
                input.request_id,
                input.client_id,
                requested_scopes,
                input.user_code,
                input.requested_at,
                input.expires_at,
            ],
        )?;
        Ok(())
    }

    pub fn approve_authorization_request(
        &self,
        id: &str,
        granted_scopes: &[String],
        patient: Option<&str>,
    ) -> crate::store::DbResult<()> {
        let scopes_json = serde_json::to_string(granted_scopes).unwrap();
        self.conn().lock().execute(
            "UPDATE authorizationRequests
             SET status = 'approved', grantedScopes = ?2, patient = ?3
             WHERE id = ?1",
            params![id, scopes_json, patient],
        )?;
        Ok(())
    }

    pub fn deny_authorization_request(&self, id: &str) -> crate::store::DbResult<()> {
        self.conn().lock().execute(
            "UPDATE authorizationRequests SET status = 'denied' WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    }

    pub fn expire_authorization_request(&self, id: &str) -> crate::store::DbResult<()> {
        self.conn().lock().execute(
            "UPDATE authorizationRequests SET status = 'expired' WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    }

    pub fn record_device_poll(&self, id: &str, polled_at: &str) -> crate::store::DbResult<()> {
        self.conn().lock().execute(
            "UPDATE authorizationRequests SET lastPolledAt = ?2 WHERE id = ?1",
            params![id, polled_at],
        )?;
        Ok(())
    }
}

pub struct StartCodeRequest {
    pub request_id: String,
    pub client_id: String,
    pub requested_scopes: Vec<String>,
    pub code_challenge: String,
    pub redirect_uri: String,
    pub client_state: String,
    pub pre_approved_scopes: Option<Vec<String>>,
    pub requested_at: String,
    pub expires_at: String,
}

pub struct StartDeviceRequest {
    pub request_id: String,
    pub client_id: String,
    pub requested_scopes: Vec<String>,
    pub user_code: String,
    pub requested_at: String,
    pub expires_at: String,
}
