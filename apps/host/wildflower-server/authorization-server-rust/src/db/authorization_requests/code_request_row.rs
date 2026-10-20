//! `code_authorization_requests` — the code flow's requests, one row per
//! [`CodeRequest`], keyed by its id. The row is diesel-mapped as
//! [`CodeAuthorizationRequestRow`] and read into the request by its `TryFrom`,
//! the one place the row's status is checked against its approval columns.

use chrono::{DateTime, Utc};
use diesel::prelude::*;

use super::approval_from_columns;
use crate::db::clients::clients;
use crate::db::shared::{JsonStrings, UrlText};
use crate::domain::authorization_request::code::{CodeRequest, CodeRequestState};
use crate::domain::authorization_request::RequestStatus;
use crate::domain::authorization_server_error::AuthorizationServerError;

diesel::table! {
    code_authorization_requests (id) {
        id -> Text,
        client_id -> Text,
        requested_scopes -> Text,
        requested_at -> TimestamptzSqlite,
        expires_at -> TimestamptzSqlite,
        status -> Text,
        granted_scopes -> Nullable<Text>,
        patient -> Nullable<Text>,
        redirect_uri -> Text,
        code_challenge -> Text,
        client_state -> Text,
        sid -> Text,
        launch -> Nullable<Text>,
        launch_bound_patient -> Nullable<Text>,
        pre_approved_scopes -> Text,
        decidable_in_requesting_browser -> Bool,
    }
}

diesel::allow_tables_to_appear_in_same_query!(code_authorization_requests, clients);

/// One `code_authorization_requests` row. The approval is `granted_scopes`
/// and `patient`, set only while the request is approved.
#[derive(Queryable, Selectable, Insertable, AsChangeset)]
#[diesel(table_name = code_authorization_requests)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
#[diesel(treat_none_as_null = true)]
pub(super) struct CodeAuthorizationRequestRow {
    pub(super) id: String,
    client_id: String,
    requested_scopes: JsonStrings,
    requested_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
    status: RequestStatus,
    granted_scopes: Option<JsonStrings>,
    patient: Option<String>,
    redirect_uri: UrlText,
    code_challenge: String,
    client_state: String,
    sid: String,
    launch: Option<String>,
    launch_bound_patient: Option<String>,
    pre_approved_scopes: JsonStrings,
    decidable_in_requesting_browser: bool,
}

impl CodeAuthorizationRequestRow {
    /// The read failure for this row: `problem`, named with its id.
    fn malformed(&self, problem: &str) -> AuthorizationServerError {
        AuthorizationServerError::infrastructure(
            "malformed code authorization request row",
            format!("code request {} {problem}", self.id),
        )
    }
}

impl TryFrom<CodeAuthorizationRequestRow> for CodeRequest {
    type Error = AuthorizationServerError;

    fn try_from(mut row: CodeAuthorizationRequestRow) -> Result<Self, Self::Error> {
        let approval = approval_from_columns(
            row.status,
            row.granted_scopes.take(),
            row.patient.take(),
            |problem| row.malformed(problem),
        )?;
        let state = match (row.status, approval) {
            (RequestStatus::AwaitingLimitedPage, None) => CodeRequestState::AwaitingLimitedPage,
            (RequestStatus::Pending, None) => CodeRequestState::Pending,
            (RequestStatus::Approved, Some(approval)) => CodeRequestState::Approved(approval),
            (RequestStatus::Denied, None) => CodeRequestState::Denied,
            (status, _) => {
                return Err(row.malformed(&format!("is {status}, which its flow never is")));
            }
        };
        Ok(CodeRequest {
            id: row.id,
            client_id: row.client_id,
            requested_scopes: row.requested_scopes.0,
            requested_at: row.requested_at,
            expires_at: row.expires_at,
            state,
            redirect_uri: row.redirect_uri.0,
            code_challenge: row.code_challenge,
            client_state: row.client_state,
            sid: row.sid,
            launch: row.launch,
            launch_bound_patient: row.launch_bound_patient,
            pre_approved_scopes: row.pre_approved_scopes.0,
            decidable_in_requesting_browser: row.decidable_in_requesting_browser,
        })
    }
}

impl From<&CodeRequest> for CodeAuthorizationRequestRow {
    fn from(request: &CodeRequest) -> Self {
        let approval = request.state.approval();
        CodeAuthorizationRequestRow {
            id: request.id.clone(),
            client_id: request.client_id.clone(),
            requested_scopes: JsonStrings(request.requested_scopes.clone()),
            requested_at: request.requested_at,
            expires_at: request.expires_at,
            status: request.state.status(),
            granted_scopes: approval.map(|approval| JsonStrings(approval.granted_scopes.clone())),
            patient: approval.and_then(|approval| approval.patient.clone()),
            redirect_uri: UrlText(request.redirect_uri.clone()),
            code_challenge: request.code_challenge.clone(),
            client_state: request.client_state.clone(),
            sid: request.sid.clone(),
            launch: request.launch.clone(),
            launch_bound_patient: request.launch_bound_patient.clone(),
            pre_approved_scopes: JsonStrings(request.pre_approved_scopes.clone()),
            decidable_in_requesting_browser: request.decidable_in_requesting_browser,
        }
    }
}
