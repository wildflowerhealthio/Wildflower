//! `user_code_requests` — the requests keyed by a `user_code` the Owner
//! enters and claimed by a poll: device requests and browser pairings, side
//! by side, told apart by `flow`. The domain never sees that they share a
//! table. The row is diesel-mapped as [`UserCodeRequestRow`] and read into the
//! flow's struct by the `TryFrom` conversions here, the one place its columns
//! are checked against its flow and status.

use chrono::{DateTime, Utc};
use diesel::prelude::*;

use super::approval_from_columns;
use crate::db::clients::clients;
use crate::db::shared::JsonStrings;
use crate::domain::authorization_request::approval::Approval;
use crate::domain::authorization_request::device::DeviceRequest;
use crate::domain::authorization_request::pairing::{PairingApproval, PairingRequest};
use crate::domain::authorization_request::polled::{PolledRequest, PolledState};
use crate::domain::authorization_request::{FlowType, RequestStatus};
use crate::domain::authorization_server_error::AuthorizationServerError;

diesel::table! {
    user_code_requests (id) {
        id -> Text,
        flow -> Text,
        client_id -> Text,
        requested_scopes -> Text,
        requested_at -> TimestamptzSqlite,
        expires_at -> TimestamptzSqlite,
        status -> Text,
        granted_scopes -> Nullable<Text>,
        patient -> Nullable<Text>,
        user_code -> Text,
        device_name -> Nullable<Text>,
        last_polled_at -> Nullable<TimestamptzSqlite>,
    }
}

diesel::allow_tables_to_appear_in_same_query!(user_code_requests, clients);

/// One `user_code_requests` row, one field per column of the same name. A
/// browser pairing keeps its browser's name in `device_name`, the column the
/// device page reads a requester's name from. The approval is
/// `granted_scopes` and `patient`, set only while the request is approved or
/// claimed; the table's CHECKs hold it to that, to a `status` these flows
/// have, and a pairing to a name and no patient.
///
/// Two indexes on `user_code` serve the device page: a plain one for its
/// lookups by the code the Owner types or confirms, and
/// `user_code_requests_pending_user_code_uidx`, unique where `status` is
/// `pending`, so **at most one pending request holds a user code**. Decided
/// and claimed rows are outside it, so they may share a code with each other
/// and with one pending request.
#[derive(Queryable, Selectable, Insertable, AsChangeset)]
#[diesel(table_name = user_code_requests)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
#[diesel(treat_none_as_null = true)]
pub(super) struct UserCodeRequestRow {
    /// The primary key: the device's `device_code`, or the pairing code, the
    /// secret the requester polls with.
    pub(super) id: String,
    /// Which flow the row is, as its wire string: `device_code` or
    /// `browser_pairing`. A read by id filters on it, so a device code never
    /// reads as a pairing.
    pub(super) flow: FlowType,
    /// The client that made the request: the device's client, or the
    /// browser-session client for a pairing.
    client_id: String,
    /// The scopes the requester asked for, as a JSON array.
    requested_scopes: JsonStrings,
    /// When the request started; the Owner prompt orders by it.
    pub(super) requested_at: DateTime<Utc>,
    /// When the request stops waiting for a decision, and the requester stops
    /// being able to claim it. The retention sweep deletes a row by it,
    /// whatever its status.
    expires_at: DateTime<Utc>,
    /// Where the request stands, as its wire string: `pending`, `approved`,
    /// `denied` or `claimed`. A replace lands only on a row still at the
    /// status it was read with.
    status: RequestStatus,
    /// The approved scopes, as a JSON array: set exactly while `status` is
    /// `approved` or `claimed`.
    granted_scopes: Option<JsonStrings>,
    /// The patient a device approval binds, if any; only ever set beside
    /// `granted_scopes`, and never on a pairing.
    patient: Option<String>,
    /// The short code the Owner enters or confirms on the device page.
    pub(super) user_code: String,
    /// The requester's name: the name a device gave itself or the approver
    /// settled on (`NULL` falls back to the client's name), or the pairing
    /// browser's, which a pairing always has.
    device_name: Option<String>,
    /// When the requester last polled; the poll's slow-down check reads it.
    last_polled_at: Option<DateTime<Utc>>,
}

impl UserCodeRequestRow {
    /// The read failure for this row: `problem`, named with its id and flow.
    fn malformed(&self, problem: &str) -> AuthorizationServerError {
        AuthorizationServerError::infrastructure(
            "malformed user code request row",
            format!("{} request {} {problem}", self.flow, self.id),
        )
    }

    /// Refuse a row of another flow than `flow`.
    fn require_flow(&self, flow: FlowType) -> Result<(), AuthorizationServerError> {
        if self.flow == flow {
            Ok(())
        } else {
            Err(self.malformed(&format!("read as a {flow} request")))
        }
    }

    /// The polled state, its approval taken out of the row's approval columns
    /// and mapped to the flow's approval by `into_flow_approval`.
    fn take_state<A>(
        &mut self,
        into_flow_approval: impl FnOnce(&Self, Approval) -> Result<A, AuthorizationServerError>,
    ) -> Result<PolledState<A>, AuthorizationServerError> {
        let approval = approval_from_columns(
            self.status,
            self.granted_scopes.take(),
            self.patient.take(),
            |problem| self.malformed(problem),
        )?;
        match (self.status, approval) {
            (RequestStatus::Pending, None) => Ok(PolledState::Pending),
            (RequestStatus::Denied, None) => Ok(PolledState::Denied),
            (RequestStatus::Approved, Some(approval)) => {
                Ok(PolledState::Approved(into_flow_approval(self, approval)?))
            }
            (RequestStatus::Claimed, Some(approval)) => {
                Ok(PolledState::Claimed(into_flow_approval(self, approval)?))
            }
            (status, _) => Err(self.malformed(&format!("is {status}, which its flow never is"))),
        }
    }
}

impl TryFrom<UserCodeRequestRow> for DeviceRequest {
    type Error = AuthorizationServerError;

    fn try_from(mut row: UserCodeRequestRow) -> Result<Self, Self::Error> {
        row.require_flow(FlowType::DeviceCode)?;
        let state = row.take_state(|_, approval| Ok(approval))?;
        Ok(DeviceRequest {
            id: row.id,
            client_id: row.client_id,
            requested_scopes: row.requested_scopes.0,
            requested_at: row.requested_at,
            expires_at: row.expires_at,
            user_code: row.user_code,
            device_name: row.device_name,
            last_polled_at: row.last_polled_at,
            state,
        })
    }
}

impl TryFrom<UserCodeRequestRow> for PairingRequest {
    type Error = AuthorizationServerError;

    fn try_from(mut row: UserCodeRequestRow) -> Result<Self, Self::Error> {
        row.require_flow(FlowType::BrowserPairing)?;
        let state = row.take_state(|row, approval| match approval.patient {
            None => Ok(PairingApproval {
                granted_scopes: approval.granted_scopes,
            }),
            Some(_) => Err(row.malformed("binds a patient")),
        })?;
        let Some(browser_name) = row.device_name.take() else {
            return Err(row.malformed("has no device_name"));
        };
        Ok(PairingRequest {
            id: row.id,
            client_id: row.client_id,
            requested_scopes: row.requested_scopes.0,
            requested_at: row.requested_at,
            expires_at: row.expires_at,
            user_code: row.user_code,
            browser_name,
            last_polled_at: row.last_polled_at,
            state,
        })
    }
}

impl TryFrom<UserCodeRequestRow> for PolledRequest {
    type Error = AuthorizationServerError;

    fn try_from(row: UserCodeRequestRow) -> Result<Self, Self::Error> {
        match row.flow {
            FlowType::DeviceCode => DeviceRequest::try_from(row).map(PolledRequest::Device),
            FlowType::BrowserPairing => PairingRequest::try_from(row).map(PolledRequest::Pairing),
            FlowType::AuthorizationCode => Err(row.malformed("carries a user code")),
        }
    }
}

impl From<&DeviceRequest> for UserCodeRequestRow {
    fn from(request: &DeviceRequest) -> Self {
        let approval = request.state.approval();
        UserCodeRequestRow {
            id: request.id.clone(),
            flow: FlowType::DeviceCode,
            client_id: request.client_id.clone(),
            requested_scopes: JsonStrings(request.requested_scopes.clone()),
            requested_at: request.requested_at,
            expires_at: request.expires_at,
            status: request.state.status(),
            granted_scopes: approval.map(|approval| JsonStrings(approval.granted_scopes.clone())),
            patient: approval.and_then(|approval| approval.patient.clone()),
            user_code: request.user_code.clone(),
            device_name: request.device_name.clone(),
            last_polled_at: request.last_polled_at,
        }
    }
}

impl From<&PairingRequest> for UserCodeRequestRow {
    fn from(request: &PairingRequest) -> Self {
        UserCodeRequestRow {
            id: request.id.clone(),
            flow: FlowType::BrowserPairing,
            client_id: request.client_id.clone(),
            requested_scopes: JsonStrings(request.requested_scopes.clone()),
            requested_at: request.requested_at,
            expires_at: request.expires_at,
            status: request.state.status(),
            granted_scopes: request
                .state
                .approval()
                .map(|approval| JsonStrings(approval.granted_scopes.clone())),
            patient: None,
            user_code: request.user_code.clone(),
            device_name: Some(request.browser_name.clone()),
            last_polled_at: request.last_polled_at,
        }
    }
}
