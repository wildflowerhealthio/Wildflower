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

/// One `code_authorization_requests` row, one field per column of the same
/// name. Every column a [`CodeRequest`] always has is `NOT NULL`. The approval
/// is `granted_scopes` and `patient`, set only while the request is approved;
/// the table's CHECKs hold it to that, and to a `status` the code flow has.
/// No foreign key ties `client_id` to `clients` or `sid` to
/// `browser_sessions`: an app trusted on first use has no `clients` row yet,
/// and a session is pruned on its own schedule.
#[derive(Queryable, Selectable, Insertable, AsChangeset)]
#[diesel(table_name = code_authorization_requests)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
#[diesel(treat_none_as_null = true)]
pub(super) struct CodeAuthorizationRequestRow {
    /// The primary key: the request's UUID, so every read and write by id is
    /// a key lookup. An authorization code names its request by it.
    pub(super) id: String,
    /// The client that made the request.
    client_id: String,
    /// The scopes the client asked for, as a JSON array.
    requested_scopes: JsonStrings,
    /// When the request started; the Owner prompt orders by it.
    requested_at: DateTime<Utc>,
    /// When the request stops waiting for a decision. The retention sweep
    /// deletes a row by it, whatever its status.
    expires_at: DateTime<Utc>,
    /// Where the request stands, as its wire string: `awaiting_limited_page`,
    /// `pending`, `approved` or `denied`. A replace lands only on a row still
    /// at the status it was read with. Expiry is read from `expires_at`, never
    /// stored here.
    status: RequestStatus,
    /// The approved scopes, as a JSON array: set exactly while `status` is
    /// `approved`.
    granted_scopes: Option<JsonStrings>,
    /// The patient the approval binds, if any; only ever set beside
    /// `granted_scopes`.
    patient: Option<String>,
    /// The redirect the client presented, which its code or error goes back to.
    redirect_uri: UrlText,
    /// The PKCE S256 challenge the code's redemption is checked against.
    code_challenge: String,
    /// The `state` the client sent, which its callback carries back.
    client_state: String,
    /// The browser session the request was made in, which its code is issued
    /// under.
    sid: String,
    /// The SMART App Launch `launch` value the request consumed; `NULL` for a
    /// plain OAuth request.
    launch: Option<String>,
    /// The patient the consumed launch binds, if any, which an approval must
    /// name.
    launch_bound_patient: Option<String>,
    /// The requested scopes a standing grant already covered when the request
    /// parked, as a JSON array; the consent card shows them ticked.
    pre_approved_scopes: JsonStrings,
    /// Whether the browser that made the request can decide it itself; raising
    /// the request for the Owner clears it.
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
