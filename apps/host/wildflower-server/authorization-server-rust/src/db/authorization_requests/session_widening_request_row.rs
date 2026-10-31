//! `session_widening_requests` — the session widenings, keyed by id. The row
//! is diesel-mapped as [`SessionWideningRequestRow`] and read into a
//! [`SessionWideningRequest`] by the `TryFrom` conversion here, the one place
//! its approval column is checked against its status.

use chrono::{DateTime, Utc};
use diesel::prelude::*;

use super::approval_from_columns;
use crate::db::clients::clients;
use crate::db::shared::JsonStrings;
use crate::domain::authorization_request::polled::PolledState;
use crate::domain::authorization_request::session_widening::{
    SessionWideningApproval, SessionWideningRequest,
};
use crate::domain::authorization_request::RequestStatus;
use crate::domain::authorization_server_error::AuthorizationServerError;

diesel::table! {
    session_widening_requests (id) {
        id -> Text,
        sid -> Text,
        client_id -> Text,
        browser_name -> Text,
        requested_scopes -> Text,
        requested_at -> TimestamptzSqlite,
        expires_at -> TimestamptzSqlite,
        status -> Text,
        granted_scopes -> Nullable<Text>,
    }
}

diesel::allow_tables_to_appear_in_same_query!(session_widening_requests, clients);

/// One `session_widening_requests` row, one field per column of the same
/// name. The approval is `granted_scopes`, set only while the widening is
/// approved or claimed; the table's CHECKs hold it to that, and to a
/// `status` a widening has.
#[derive(Queryable, Selectable, Insertable, AsChangeset)]
#[diesel(table_name = session_widening_requests)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
#[diesel(treat_none_as_null = true)]
pub(super) struct SessionWideningRequestRow {
    /// The primary key: the widening's internal UUID.
    pub(super) id: String,
    /// The browser session the widening widens.
    sid: String,
    /// The app whose request the session fell short of.
    client_id: String,
    /// The session's name when the browser asked.
    browser_name: String,
    /// The scopes the session lacked, as a JSON array.
    requested_scopes: JsonStrings,
    /// When the browser asked; the Owner prompt orders by it.
    pub(super) requested_at: DateTime<Utc>,
    /// When the widening stops waiting for a decision. The retention sweep
    /// deletes a row by it, whatever its status.
    expires_at: DateTime<Utc>,
    /// Where the widening stands, as its wire string: `pending`, `approved`,
    /// `denied` or `claimed`. A replace lands only on a row still at the
    /// status it was read with.
    status: RequestStatus,
    /// The approved scopes, as a JSON array: set exactly while `status` is
    /// `approved` or `claimed`.
    granted_scopes: Option<JsonStrings>,
}

impl SessionWideningRequestRow {
    /// The read failure for this row: `problem`, named with its id.
    fn malformed(&self, problem: &str) -> AuthorizationServerError {
        AuthorizationServerError::infrastructure(
            "malformed session widening row",
            format!("session widening {} {problem}", self.id),
        )
    }
}

impl TryFrom<SessionWideningRequestRow> for SessionWideningRequest {
    type Error = AuthorizationServerError;

    fn try_from(mut row: SessionWideningRequestRow) -> Result<Self, Self::Error> {
        let approval =
            approval_from_columns(row.status, row.granted_scopes.take(), None, |problem| {
                row.malformed(problem)
            })?
            .map(|approval| SessionWideningApproval {
                granted_scopes: approval.granted_scopes,
            });
        let state = match (row.status, approval) {
            (RequestStatus::Pending, None) => PolledState::Pending,
            (RequestStatus::Denied, None) => PolledState::Denied,
            (RequestStatus::Approved, Some(approval)) => PolledState::Approved(approval),
            (RequestStatus::Claimed, Some(approval)) => PolledState::Claimed(approval),
            (status, _) => {
                return Err(row.malformed(&format!("is {status}, which a widening never is")))
            }
        };
        Ok(SessionWideningRequest {
            id: row.id,
            sid: row.sid,
            client_id: row.client_id,
            browser_name: row.browser_name,
            requested_scopes: row.requested_scopes.0,
            requested_at: row.requested_at,
            expires_at: row.expires_at,
            state,
        })
    }
}

impl From<&SessionWideningRequest> for SessionWideningRequestRow {
    fn from(request: &SessionWideningRequest) -> Self {
        SessionWideningRequestRow {
            id: request.id.clone(),
            sid: request.sid.clone(),
            client_id: request.client_id.clone(),
            browser_name: request.browser_name.clone(),
            requested_scopes: JsonStrings(request.requested_scopes.clone()),
            requested_at: request.requested_at,
            expires_at: request.expires_at,
            status: request.state.status(),
            granted_scopes: request
                .state
                .approval()
                .map(|approval| JsonStrings(approval.granted_scopes.clone())),
        }
    }
}
