//! `authorization_requests` — the requests the Owner decides, every flow's in
//! one table, one row per request with a column for every flow's fields. The
//! row is diesel-mapped as the private [`Row`], and read into the flow's
//! struct by the `TryFrom` conversions here, the one place the columns are
//! checked against the flow and status: a row missing a column its flow
//! requires, or whose approval columns disagree with its status, fails the
//! read as malformed rather than reading as absent.

use chrono::{DateTime, Utc};
use diesel::prelude::*;

use crate::db::clients::clients;
use crate::db::grant_store::SqliteGrantTx;
use crate::db::shared::{text_enum_column, JsonStrings, UrlText};
use crate::domain::authorization_request::approval::Approval;
use crate::domain::authorization_request::code::{CodeRequest, CodeRequestState};
use crate::domain::authorization_request::device::DeviceRequest;
use crate::domain::authorization_request::pairing::{PairingApproval, PairingRequest};
use crate::domain::authorization_request::polled::{PolledRequest, PolledState};
use crate::domain::authorization_request::{AuthorizationRequest, FlowType, RequestStatus};
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::consent_key::ConsentKey;
use crate::domain::grant_store::{AuthorizationRequestsTx, ClientsTx};
use crate::domain::owner_prompt::OwnerPrompt;

diesel::table! {
    authorization_requests (id) {
        id -> Text,
        grant_type -> Text,
        client_id -> Text,
        requested_scopes -> Text,
        code_challenge -> Nullable<Text>,
        redirect_uri -> Nullable<Text>,
        client_state -> Nullable<Text>,
        user_code -> Nullable<Text>,
        pre_approved_scopes -> Text,
        requested_at -> TimestamptzSqlite,
        expires_at -> TimestamptzSqlite,
        last_polled_at -> Nullable<TimestamptzSqlite>,
        status -> Text,
        granted_scopes -> Nullable<Text>,
        patient -> Nullable<Text>,
        device_name -> Nullable<Text>,
        launch -> Nullable<Text>,
        launch_bound_patient -> Nullable<Text>,
        decidable_in_requesting_browser -> Bool,
        sid -> Nullable<Text>,
    }
}

diesel::allow_tables_to_appear_in_same_query!(authorization_requests, clients);

// The request `status` discriminant, stored as its strum wire string. Only the
// authorization request binds it, so its mapping lives here.
text_enum_column!(RequestStatus);

/// One `authorization_requests` row, every flow's columns side by side. A
/// browser pairing keeps its browser's name in `device_name`, the column the
/// device page reads a requester's name from. The approval is
/// `granted_scopes` and `patient`.
#[derive(Queryable, Selectable, Insertable, AsChangeset)]
#[diesel(table_name = authorization_requests)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
#[diesel(treat_none_as_null = true)]
struct Row {
    id: String,
    grant_type: FlowType,
    client_id: String,
    requested_scopes: JsonStrings,
    code_challenge: Option<String>,
    redirect_uri: Option<UrlText>,
    client_state: Option<String>,
    user_code: Option<String>,
    pre_approved_scopes: JsonStrings,
    requested_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
    last_polled_at: Option<DateTime<Utc>>,
    status: RequestStatus,
    granted_scopes: Option<JsonStrings>,
    patient: Option<String>,
    device_name: Option<String>,
    launch: Option<String>,
    launch_bound_patient: Option<String>,
    decidable_in_requesting_browser: bool,
    sid: Option<String>,
}

impl Row {
    /// The read failure for this row: `problem`, named with its id and flow.
    fn malformed(&self, problem: &str) -> AuthorizationServerError {
        AuthorizationServerError::infrastructure(
            "malformed authorization request row",
            format!("{} request {} {problem}", self.grant_type, self.id),
        )
    }

    /// Refuse a row of another flow than `flow`.
    fn require_flow(&self, flow: FlowType) -> Result<(), AuthorizationServerError> {
        if self.grant_type == flow {
            Ok(())
        } else {
            Err(self.malformed(&format!("read as a {flow} request")))
        }
    }

    /// The approval columns, `granted_scopes` and `patient`, taken out of the
    /// row: present exactly when the status is approved or claimed, and a
    /// patient only beside granted scopes.
    fn take_approval(&mut self) -> Result<Option<Approval>, AuthorizationServerError> {
        let carries_approval = matches!(
            self.status,
            RequestStatus::Approved | RequestStatus::Claimed
        );
        match (self.granted_scopes.take(), self.patient.take()) {
            (Some(granted_scopes), patient) if carries_approval => Ok(Some(Approval {
                granted_scopes: granted_scopes.0,
                patient,
            })),
            (None, None) if !carries_approval => Ok(None),
            _ => Err(self.malformed(&format!(
                "is {} but its approval columns disagree",
                self.status
            ))),
        }
    }

    /// The column `name` a flow requires, or the read failure for its absence.
    fn required<T>(&self, column: Option<T>, name: &str) -> Result<T, AuthorizationServerError> {
        column.ok_or_else(|| self.malformed(&format!("has no {name}")))
    }

    /// The polled flows' state, carrying `approval` mapped to the flow's
    /// approval by `into_flow_approval`.
    fn polled_state<A>(
        &self,
        approval: Option<Approval>,
        into_flow_approval: impl FnOnce(Approval) -> Result<A, AuthorizationServerError>,
    ) -> Result<PolledState<A>, AuthorizationServerError> {
        match (self.status, approval) {
            (RequestStatus::Pending, None) => Ok(PolledState::Pending),
            (RequestStatus::Denied, None) => Ok(PolledState::Denied),
            (RequestStatus::Approved, Some(approval)) => {
                Ok(PolledState::Approved(into_flow_approval(approval)?))
            }
            (RequestStatus::Claimed, Some(approval)) => {
                Ok(PolledState::Claimed(into_flow_approval(approval)?))
            }
            (status, _) => Err(self.malformed(&format!("is {status}, which its flow never is"))),
        }
    }
}

impl TryFrom<Row> for CodeRequest {
    type Error = AuthorizationServerError;

    fn try_from(mut row: Row) -> Result<Self, Self::Error> {
        row.require_flow(FlowType::AuthorizationCode)?;
        let approval = row.take_approval()?;
        let state = match (row.status, approval) {
            (RequestStatus::AwaitingLimitedPage, None) => CodeRequestState::AwaitingLimitedPage,
            (RequestStatus::Pending, None) => CodeRequestState::Pending,
            (RequestStatus::Approved, Some(approval)) => CodeRequestState::Approved(approval),
            (RequestStatus::Denied, None) => CodeRequestState::Denied,
            (status, _) => {
                return Err(row.malformed(&format!("is {status}, which its flow never is")));
            }
        };
        let (redirect_uri, code_challenge, client_state, sid) = (
            row.redirect_uri.take(),
            row.code_challenge.take(),
            row.client_state.take(),
            row.sid.take(),
        );
        Ok(CodeRequest {
            redirect_uri: row.required(redirect_uri, "redirect_uri")?.0,
            code_challenge: row.required(code_challenge, "code_challenge")?,
            client_state: row.required(client_state, "client_state")?,
            sid: row.required(sid, "sid")?,
            state,
            launch: row.launch,
            launch_bound_patient: row.launch_bound_patient,
            pre_approved_scopes: row.pre_approved_scopes.0,
            decidable_in_requesting_browser: row.decidable_in_requesting_browser,
            id: row.id,
            client_id: row.client_id,
            requested_scopes: row.requested_scopes.0,
            requested_at: row.requested_at,
            expires_at: row.expires_at,
        })
    }
}

impl TryFrom<Row> for DeviceRequest {
    type Error = AuthorizationServerError;

    fn try_from(mut row: Row) -> Result<Self, Self::Error> {
        row.require_flow(FlowType::DeviceCode)?;
        let approval = row.take_approval()?;
        let user_code = row.user_code.take();
        Ok(DeviceRequest {
            state: row.polled_state(approval, Ok)?,
            user_code: row.required(user_code, "user_code")?,
            device_name: row.device_name,
            last_polled_at: row.last_polled_at,
            id: row.id,
            client_id: row.client_id,
            requested_scopes: row.requested_scopes.0,
            requested_at: row.requested_at,
            expires_at: row.expires_at,
        })
    }
}

impl TryFrom<Row> for PairingRequest {
    type Error = AuthorizationServerError;

    fn try_from(mut row: Row) -> Result<Self, Self::Error> {
        row.require_flow(FlowType::BrowserPairing)?;
        let approval = row.take_approval()?;
        let state = row.polled_state(approval, |approval| match approval.patient {
            None => Ok(PairingApproval {
                granted_scopes: approval.granted_scopes,
            }),
            Some(_) => Err(row.malformed("binds a patient")),
        })?;
        let (user_code, browser_name) = (row.user_code.take(), row.device_name.take());
        Ok(PairingRequest {
            state,
            user_code: row.required(user_code, "user_code")?,
            browser_name: row.required(browser_name, "device_name")?,
            last_polled_at: row.last_polled_at,
            id: row.id,
            client_id: row.client_id,
            requested_scopes: row.requested_scopes.0,
            requested_at: row.requested_at,
            expires_at: row.expires_at,
        })
    }
}

impl TryFrom<Row> for PolledRequest {
    type Error = AuthorizationServerError;

    fn try_from(row: Row) -> Result<Self, Self::Error> {
        match row.grant_type {
            FlowType::DeviceCode => DeviceRequest::try_from(row).map(PolledRequest::Device),
            FlowType::BrowserPairing => PairingRequest::try_from(row).map(PolledRequest::Pairing),
            FlowType::AuthorizationCode => Err(row.malformed("carries a user code")),
        }
    }
}

impl TryFrom<Row> for AuthorizationRequest {
    type Error = AuthorizationServerError;

    fn try_from(row: Row) -> Result<Self, Self::Error> {
        match row.grant_type {
            FlowType::AuthorizationCode => {
                CodeRequest::try_from(row).map(AuthorizationRequest::Code)
            }
            FlowType::DeviceCode => DeviceRequest::try_from(row).map(AuthorizationRequest::Device),
            FlowType::BrowserPairing => {
                PairingRequest::try_from(row).map(AuthorizationRequest::Pairing)
            }
        }
    }
}

impl From<&CodeRequest> for Row {
    fn from(request: &CodeRequest) -> Self {
        let approval = request.state.approval();
        Row {
            id: request.id.clone(),
            grant_type: FlowType::AuthorizationCode,
            client_id: request.client_id.clone(),
            requested_scopes: JsonStrings(request.requested_scopes.clone()),
            code_challenge: Some(request.code_challenge.clone()),
            redirect_uri: Some(UrlText(request.redirect_uri.clone())),
            client_state: Some(request.client_state.clone()),
            user_code: None,
            pre_approved_scopes: JsonStrings(request.pre_approved_scopes.clone()),
            requested_at: request.requested_at,
            expires_at: request.expires_at,
            last_polled_at: None,
            status: request.state.status(),
            granted_scopes: approval.map(|approval| JsonStrings(approval.granted_scopes.clone())),
            patient: approval.and_then(|approval| approval.patient.clone()),
            device_name: None,
            launch: request.launch.clone(),
            launch_bound_patient: request.launch_bound_patient.clone(),
            decidable_in_requesting_browser: request.decidable_in_requesting_browser,
            sid: Some(request.sid.clone()),
        }
    }
}

/// The row of a polled request of `grant_type`: the columns every flow has,
/// its `user_code`, the requester's name, its last poll, and its approval as
/// `granted_scopes` and `patient`. The code flow's columns are empty.
struct PolledRow<'a> {
    grant_type: FlowType,
    id: &'a str,
    client_id: &'a str,
    requested_scopes: &'a [String],
    requested_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
    user_code: &'a str,
    requester_name: Option<&'a str>,
    last_polled_at: Option<DateTime<Utc>>,
    status: RequestStatus,
    granted_scopes: Option<&'a [String]>,
    patient: Option<&'a str>,
}

impl From<PolledRow<'_>> for Row {
    fn from(polled: PolledRow<'_>) -> Self {
        Row {
            id: polled.id.to_owned(),
            grant_type: polled.grant_type,
            client_id: polled.client_id.to_owned(),
            requested_scopes: JsonStrings(polled.requested_scopes.to_vec()),
            code_challenge: None,
            redirect_uri: None,
            client_state: None,
            user_code: Some(polled.user_code.to_owned()),
            pre_approved_scopes: JsonStrings(Vec::new()),
            requested_at: polled.requested_at,
            expires_at: polled.expires_at,
            last_polled_at: polled.last_polled_at,
            status: polled.status,
            granted_scopes: polled
                .granted_scopes
                .map(|granted_scopes| JsonStrings(granted_scopes.to_vec())),
            patient: polled.patient.map(str::to_owned),
            device_name: polled.requester_name.map(str::to_owned),
            launch: None,
            launch_bound_patient: None,
            decidable_in_requesting_browser: false,
            sid: None,
        }
    }
}

impl From<&DeviceRequest> for Row {
    fn from(request: &DeviceRequest) -> Self {
        let approval = request.state.approval();
        Row::from(PolledRow {
            grant_type: FlowType::DeviceCode,
            id: &request.id,
            client_id: &request.client_id,
            requested_scopes: &request.requested_scopes,
            requested_at: request.requested_at,
            expires_at: request.expires_at,
            user_code: &request.user_code,
            requester_name: request.device_name.as_deref(),
            last_polled_at: request.last_polled_at,
            status: request.state.status(),
            granted_scopes: approval.map(|approval| approval.granted_scopes.as_slice()),
            patient: approval.and_then(|approval| approval.patient.as_deref()),
        })
    }
}

impl From<&PairingRequest> for Row {
    fn from(request: &PairingRequest) -> Self {
        Row::from(PolledRow {
            grant_type: FlowType::BrowserPairing,
            id: &request.id,
            client_id: &request.client_id,
            requested_scopes: &request.requested_scopes,
            requested_at: request.requested_at,
            expires_at: request.expires_at,
            user_code: &request.user_code,
            requester_name: Some(&request.browser_name),
            last_polled_at: request.last_polled_at,
            status: request.state.status(),
            granted_scopes: request
                .state
                .approval()
                .map(|approval| approval.granted_scopes.as_slice()),
            patient: None,
        })
    }
}

/// `operation`'s failure, as the opaque infrastructure error.
fn failed(
    operation: &'static str,
) -> impl FnOnce(diesel::result::Error) -> AuthorizationServerError {
    move |error| AuthorizationServerError::infrastructure(operation, error)
}

impl SqliteGrantTx<'_> {
    /// The row keyed `id` of `flow`, read into the flow's struct `R`.
    fn flow_row_by_id<R: TryFrom<Row, Error = AuthorizationServerError>>(
        &mut self,
        id: &str,
        flow: FlowType,
        operation: &'static str,
    ) -> Result<Option<R>, AuthorizationServerError> {
        authorization_requests::table
            .find(id)
            .filter(authorization_requests::grant_type.eq(flow))
            .select(Row::as_select())
            .first(self.conn)
            .optional()
            .map_err(failed(operation))?
            .map(R::try_from)
            .transpose()
    }

    /// Insert a polled request's `row`, first clearing an already-expired
    /// pending row holding its `user_code` (as of the request's start): that
    /// row occupies the partial unique index the insert would otherwise
    /// collide with. Bulk reclamation is the retention sweep's; see
    /// `authorization-server-rust/docs/Retention Explanation.md`.
    fn insert_polled_row(&mut self, row: &Row) -> Result<(), AuthorizationServerError> {
        diesel::delete(
            authorization_requests::table
                .filter(authorization_requests::user_code.eq(&row.user_code))
                .filter(authorization_requests::status.eq(RequestStatus::Pending))
                .filter(authorization_requests::expires_at.lt(row.requested_at)),
        )
        .execute(self.conn)
        .map_err(failed("insert_polled_row failed"))?;
        diesel::insert_into(authorization_requests::table)
            .values(row)
            .execute(self.conn)
            .map_err(failed("insert_polled_row failed"))?;
        Ok(())
    }

    /// One `UPDATE` of every column but the key to `changed`, guarded on the
    /// key, the flow and the status `read_status` the request was read with.
    fn replace_row(
        &mut self,
        read_id: &str,
        read_status: RequestStatus,
        changed: &Row,
    ) -> Result<bool, AuthorizationServerError> {
        if changed.id != read_id {
            return Err(AuthorizationServerError::infrastructure(
                "replace_authorization_request refused",
                format!("request {read_id} replaced by request {}", changed.id),
            ));
        }
        let affected = diesel::update(
            authorization_requests::table
                .find(read_id)
                .filter(authorization_requests::grant_type.eq(changed.grant_type))
                .filter(authorization_requests::status.eq(read_status)),
        )
        .set(changed)
        .execute(self.conn)
        .map_err(failed("replace_authorization_request failed"))?;
        Ok(affected == 1)
    }
}

impl AuthorizationRequestsTx for SqliteGrantTx<'_> {
    fn authorization_request_by_id(
        &mut self,
        id: &str,
    ) -> Result<Option<AuthorizationRequest>, AuthorizationServerError> {
        authorization_requests::table
            .find(id)
            .select(Row::as_select())
            .first(self.conn)
            .optional()
            .map_err(failed("authorization_request_by_id failed"))?
            .map(AuthorizationRequest::try_from)
            .transpose()
    }

    fn code_request_by_id(
        &mut self,
        id: &str,
    ) -> Result<Option<CodeRequest>, AuthorizationServerError> {
        self.flow_row_by_id(id, FlowType::AuthorizationCode, "code_request_by_id failed")
    }

    fn device_request_by_id(
        &mut self,
        device_code: &str,
    ) -> Result<Option<DeviceRequest>, AuthorizationServerError> {
        self.flow_row_by_id(
            device_code,
            FlowType::DeviceCode,
            "device_request_by_id failed",
        )
    }

    fn pairing_request_by_id(
        &mut self,
        pairing_code: &str,
    ) -> Result<Option<PairingRequest>, AuthorizationServerError> {
        self.flow_row_by_id(
            pairing_code,
            FlowType::BrowserPairing,
            "pairing_request_by_id failed",
        )
    }

    fn polled_request_by_user_code(
        &mut self,
        user_code: &str,
    ) -> Result<Option<PolledRequest>, AuthorizationServerError> {
        authorization_requests::table
            .filter(authorization_requests::user_code.eq(user_code))
            .select(Row::as_select())
            .first(self.conn)
            .optional()
            .map_err(failed("polled_request_by_user_code failed"))?
            .map(PolledRequest::try_from)
            .transpose()
    }

    fn pending_polled_request_by_user_code(
        &mut self,
        user_code: &str,
    ) -> Result<Option<PolledRequest>, AuthorizationServerError> {
        authorization_requests::table
            .filter(authorization_requests::user_code.eq(user_code))
            .filter(authorization_requests::status.eq(RequestStatus::Pending))
            .select(Row::as_select())
            .first(self.conn)
            .optional()
            .map_err(failed("pending_polled_request_by_user_code failed"))?
            .map(PolledRequest::try_from)
            .transpose()
    }

    /// The client's name comes from its registration through a left join: a
    /// client trusted on first use has none until the Owner approves it. A
    /// disabled client's request is skipped, a client with no row's kept (the
    /// rule on [`OwnerPrompt`]). Only `pending` rows are candidates, so a code
    /// request still on its browser's limited page is none.
    fn owner_prompt(
        &mut self,
        now: DateTime<Utc>,
    ) -> Result<Option<OwnerPrompt>, AuthorizationServerError> {
        let row = authorization_requests::table
            .left_join(clients::table.on(clients::client_id.eq(authorization_requests::client_id)))
            .filter(authorization_requests::status.eq(RequestStatus::Pending))
            .filter(authorization_requests::expires_at.gt(now))
            .filter(clients::disabled_at.is_null())
            .order(authorization_requests::requested_at.desc())
            .select((Row::as_select(), clients::name.nullable()))
            .first::<(Row, Option<String>)>(self.conn)
            .optional()
            .map_err(failed("owner_prompt failed"))?;
        row.map(|(row, registered_client_name)| {
            let request = AuthorizationRequest::try_from(row)?;
            Ok(OwnerPrompt::for_request(&request, registered_client_name))
        })
        .transpose()
    }

    /// The request by the key `consent_key` carries, then its client's
    /// `disabled_at`, both within the caller's scope.
    fn is_awaiting_owner(
        &mut self,
        consent_key: &ConsentKey,
        now: DateTime<Utc>,
    ) -> Result<bool, AuthorizationServerError> {
        let request = match consent_key {
            ConsentKey::DeviceCode { user_code } | ConsentKey::BrowserPairing { user_code } => self
                .pending_polled_request_by_user_code(user_code)?
                .map(AuthorizationRequest::from),
            ConsentKey::AuthorizationCode { id } => {
                self.code_request_by_id(id)?.map(AuthorizationRequest::Code)
            }
        };
        match request {
            Some(request) if request.is_undecided_at(now) => {
                Ok(!self.is_client_disabled(request.client_id())?)
            }
            _ => Ok(false),
        }
    }

    fn insert_code_request(
        &mut self,
        request: &CodeRequest,
    ) -> Result<(), AuthorizationServerError> {
        diesel::insert_into(authorization_requests::table)
            .values(Row::from(request))
            .execute(self.conn)
            .map_err(failed("insert_code_request failed"))?;
        Ok(())
    }

    fn insert_device_request(
        &mut self,
        request: &DeviceRequest,
    ) -> Result<(), AuthorizationServerError> {
        self.insert_polled_row(&Row::from(request))
    }

    fn insert_pairing_request(
        &mut self,
        request: &PairingRequest,
    ) -> Result<(), AuthorizationServerError> {
        self.insert_polled_row(&Row::from(request))
    }

    fn replace_code_request(
        &mut self,
        read: &CodeRequest,
        changed: &CodeRequest,
    ) -> Result<bool, AuthorizationServerError> {
        self.replace_row(&read.id, read.state.status(), &Row::from(changed))
    }

    fn replace_device_request(
        &mut self,
        read: &DeviceRequest,
        changed: &DeviceRequest,
    ) -> Result<bool, AuthorizationServerError> {
        self.replace_row(&read.id, read.state.status(), &Row::from(changed))
    }

    fn replace_pairing_request(
        &mut self,
        read: &PairingRequest,
        changed: &PairingRequest,
    ) -> Result<bool, AuthorizationServerError> {
        self.replace_row(&read.id, read.state.status(), &Row::from(changed))
    }

    fn delete_authorization_requests_expired_before(
        &mut self,
        cutoff: DateTime<Utc>,
    ) -> Result<usize, AuthorizationServerError> {
        diesel::delete(
            authorization_requests::table.filter(authorization_requests::expires_at.lt(cutoff)),
        )
        .execute(self.conn)
        .map_err(failed(
            "delete_authorization_requests_expired_before failed",
        ))
    }
}

#[cfg(test)]
mod tests {
    use chrono::Duration;
    use proptest::prelude::*;

    use super::*;
    use crate::db::test_support::{arb_opt_timestamp, arb_timestamp, arb_url};
    use crate::db::SqliteGrantStore;
    use crate::domain::authorization_request::code::NewCodeRequestArgs;
    use crate::domain::authorization_request::device::NewDeviceRequestArgs;
    use crate::domain::authorization_request::pairing::NewPairingRequestArgs;
    use crate::domain::client::Client;
    use crate::domain::grant_store::*;
    use crate::domain::test_fake::{
        client, code_with_status, device_with_status, fixture_code_args,
    };

    fn arb_scopes() -> impl Strategy<Value = Vec<String>> {
        prop::collection::vec("[a-z][a-z0-9_]{0,15}", 0..5)
    }

    fn arb_approval() -> impl Strategy<Value = Approval> {
        (arb_scopes(), prop::option::of("[a-zA-Z0-9-]{1,32}")).prop_map(
            |(granted_scopes, patient)| Approval {
                granted_scopes,
                patient,
            },
        )
    }

    fn arb_polled_state<A: Clone + std::fmt::Debug, S: Strategy<Value = A>>(
        arb_approval: impl Fn() -> S,
    ) -> impl Strategy<Value = PolledState<A>> {
        prop_oneof![
            Just(PolledState::Pending),
            Just(PolledState::Denied),
            arb_approval().prop_map(PolledState::Approved),
            arb_approval().prop_map(PolledState::Claimed),
        ]
    }

    prop_compose! {
        fn arb_code_request()(
            id in "[a-zA-Z0-9_-]{1,40}",
            client_id in "[a-zA-Z0-9_-]{1,32}",
            requested_scopes in arb_scopes(),
            requested_at in arb_timestamp(),
            expires_at in arb_timestamp(),
            state in prop_oneof![
                Just(CodeRequestState::AwaitingLimitedPage),
                Just(CodeRequestState::Pending),
                Just(CodeRequestState::Denied),
                arb_approval().prop_map(CodeRequestState::Approved),
            ],
            redirect_uri in arb_url(),
            code_challenge in "[A-Za-z0-9_-]{43}",
            client_state in "[A-Za-z0-9_-]{1,32}",
            sid in "[a-z0-9-]{1,16}",
            launch in prop::option::of("[A-Za-z0-9_-]{43}"),
            launch_bound_patient in prop::option::of("[a-zA-Z0-9-]{1,32}"),
            pre_approved_scopes in arb_scopes(),
            decidable_in_requesting_browser in any::<bool>(),
        ) -> CodeRequest {
            CodeRequest {
                id,
                client_id,
                requested_scopes,
                requested_at,
                expires_at,
                state,
                redirect_uri,
                code_challenge,
                client_state,
                sid,
                launch,
                launch_bound_patient,
                pre_approved_scopes,
                decidable_in_requesting_browser,
            }
        }
    }

    prop_compose! {
        fn arb_device_request()(
            id in "[a-zA-Z0-9_-]{1,40}",
            client_id in "[a-zA-Z0-9_-]{1,32}",
            requested_scopes in arb_scopes(),
            requested_at in arb_timestamp(),
            expires_at in arb_timestamp(),
            user_code in "[A-Z0-9-]{1,16}",
            device_name in prop::option::of("[ -~]{1,40}"),
            last_polled_at in arb_opt_timestamp(),
            state in arb_polled_state(arb_approval),
        ) -> DeviceRequest {
            DeviceRequest {
                id,
                client_id,
                requested_scopes,
                requested_at,
                expires_at,
                user_code,
                device_name,
                last_polled_at,
                state,
            }
        }
    }

    prop_compose! {
        fn arb_pairing_request()(
            id in "[a-zA-Z0-9_-]{1,40}",
            client_id in "[a-zA-Z0-9_-]{1,32}",
            requested_scopes in arb_scopes(),
            requested_at in arb_timestamp(),
            expires_at in arb_timestamp(),
            user_code in "[A-Z0-9-]{1,16}",
            browser_name in "[ -~]{1,40}",
            last_polled_at in arb_opt_timestamp(),
            state in arb_polled_state(
                || arb_scopes().prop_map(|granted_scopes| PairingApproval { granted_scopes })
            ),
        ) -> PairingRequest {
            PairingRequest {
                id,
                client_id,
                requested_scopes,
                requested_at,
                expires_at,
                user_code,
                browser_name,
                last_polled_at,
                state,
            }
        }
    }

    fn arb_authorization_request() -> impl Strategy<Value = AuthorizationRequest> {
        prop_oneof![
            arb_code_request().prop_map(AuthorizationRequest::Code),
            arb_device_request().prop_map(AuthorizationRequest::Device),
            arb_pairing_request().prop_map(AuthorizationRequest::Pairing),
        ]
    }

    /// Insert `request` through its flow's insert.
    fn insert_any(
        tx: &mut impl AuthorizationRequestsTx,
        request: &AuthorizationRequest,
    ) -> Result<(), AuthorizationServerError> {
        match request {
            AuthorizationRequest::Code(code_request) => tx.insert_code_request(code_request),
            AuthorizationRequest::Device(device_request) => {
                tx.insert_device_request(device_request)
            }
            AuthorizationRequest::Pairing(pairing_request) => {
                tx.insert_pairing_request(pairing_request)
            }
        }
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(64))]

        /// Every flow, in every state, reads back exactly as it was written.
        #[test]
        fn insert_and_fetch_round_trip(request in arb_authorization_request()) {
            let store = SqliteGrantStore::open_in_memory().expect("open in-memory store");
            store.write(|tx| insert_any(tx, &request)).expect("insert");
            let fetched = store
                .read(|tx| tx.authorization_request_by_id(request.id()))
                .expect("query")
                .expect("row present");
            prop_assert_eq!(fetched, request);
        }
    }

    /// A pending device request `id` from `device-client`, keyed by
    /// `user_code`, started at `now` and expiring `ttl` later.
    fn device_request_at(
        id: &str,
        user_code: &str,
        now: DateTime<Utc>,
        ttl: Duration,
    ) -> DeviceRequest {
        DeviceRequest::new(
            NewDeviceRequestArgs {
                id: id.to_owned(),
                client_id: "device-client".to_owned(),
                requested_scopes: vec!["openid".to_owned()],
                ttl,
                user_code: user_code.to_owned(),
                device_name: None,
            },
            now,
        )
    }

    /// A pending device request `id`, keyed by `UC-{id}`, live for five
    /// minutes.
    fn device_request(id: &str) -> DeviceRequest {
        device_request_at(id, &format!("UC-{id}"), Utc::now(), Duration::minutes(5))
    }

    /// A code request `id` from `app`, live for five minutes, pending or on
    /// its browser's limited page.
    fn code_request(id: &str, awaits_limited_page: bool) -> CodeRequest {
        CodeRequest::new(
            NewCodeRequestArgs {
                awaits_limited_page,
                ..fixture_code_args(id, "app", vec!["read".to_owned()])
            },
            Utc::now(),
        )
    }

    fn insert_device(store: &SqliteGrantStore, request: &DeviceRequest) {
        store
            .write(|tx| tx.insert_device_request(request))
            .expect("insert");
    }

    fn insert_code(store: &SqliteGrantStore, request: &CodeRequest) {
        store
            .write(|tx| tx.insert_code_request(request))
            .expect("insert");
    }

    fn stored(store: &SqliteGrantStore, id: &str) -> Option<AuthorizationRequest> {
        store
            .read(|tx| tx.authorization_request_by_id(id))
            .expect("query")
    }

    /// Run raw SQL against the store's database, to plant a row no flow
    /// writes.
    fn execute(store: &SqliteGrantStore, sql: &str) {
        let mut conn = store.pool().get().expect("check out a connection");
        diesel::sql_query(sql).execute(&mut conn).expect("raw SQL");
    }

    /// Each flow's loader reads its own flow's requests, and no other's.
    #[test]
    fn each_flow_s_loader_reads_only_its_own_flow() {
        let store = SqliteGrantStore::open_in_memory().expect("open in-memory store");
        let code = code_request("req-1", false);
        let device = device_request("dev-1");
        insert_code(&store, &code);
        insert_device(&store, &device);
        store
            .read(|tx| {
                assert_eq!(tx.code_request_by_id("req-1")?, Some(code.clone()));
                assert_eq!(tx.code_request_by_id("dev-1")?, None);
                assert_eq!(tx.device_request_by_id("dev-1")?, Some(device.clone()));
                assert_eq!(tx.device_request_by_id("req-1")?, None);
                assert_eq!(tx.pairing_request_by_id("dev-1")?, None);
                assert_eq!(
                    tx.polled_request_by_user_code("UC-dev-1")?,
                    Some(PolledRequest::Device(device.clone()))
                );
                Ok::<_, AuthorizationServerError>(())
            })
            .expect("reads");
    }

    /// An insert leaves an unrelated expired row for the retention sweep, so
    /// the window is the only thing that decides when it goes.
    #[test]
    fn insert_leaves_unrelated_expired_requests_for_the_sweep() {
        let store = SqliteGrantStore::open_in_memory().expect("open in-memory store");
        let ten_minutes_ago = Utc::now() - Duration::minutes(10);
        insert_device(
            &store,
            &device_request_at("expired-1", "UC-1", ten_minutes_ago, Duration::minutes(5)),
        );
        insert_device(&store, &device_request("fresh-1"));
        assert!(stored(&store, "expired-1").is_some());
        assert!(stored(&store, "fresh-1").is_some());
    }

    /// The one thing an insert prunes: a pending row holding the same
    /// `user_code` that had expired when the new request started, which sits
    /// in the partial pending-`user_code` unique index the insert would
    /// otherwise collide with.
    #[test]
    fn insert_clears_an_expired_row_holding_the_same_user_code() {
        let store = SqliteGrantStore::open_in_memory().expect("open in-memory store");
        let ten_minutes_ago = Utc::now() - Duration::minutes(10);
        insert_device(
            &store,
            &device_request_at(
                "dev-stale",
                "SAME-CODE",
                ten_minutes_ago,
                Duration::minutes(5),
            ),
        );
        let pairing = PairingRequest::new(
            NewPairingRequestArgs {
                id: "pair-new".to_owned(),
                client_id: crate::BROWSER_SESSION_CLIENT_ID.to_owned(),
                requested_scopes: crate::owner_scopes(),
                ttl: Duration::minutes(5),
                user_code: "SAME-CODE".to_owned(),
                browser_name: "Firefox on Linux".to_owned(),
            },
            Utc::now(),
        );
        store
            .write(|tx| tx.insert_pairing_request(&pairing))
            .expect("insert");
        assert!(stored(&store, "dev-stale").is_none());
        assert!(stored(&store, "pair-new").is_some());
    }

    /// A live pending request holding the code is never dropped to make
    /// room: a collision on a live code stays a hard error.
    #[test]
    fn insert_never_drops_a_live_row_holding_the_same_user_code() {
        let store = SqliteGrantStore::open_in_memory().expect("open in-memory store");
        insert_device(
            &store,
            &device_request_at("dev-live", "SAME-CODE", Utc::now(), Duration::minutes(5)),
        );
        let colliding = device_request_at("dev-new", "SAME-CODE", Utc::now(), Duration::minutes(5));
        assert!(store
            .write(|tx| tx.insert_device_request(&colliding))
            .is_err());
        assert!(stored(&store, "dev-live").is_some());
    }

    /// A decided row holding the code is outside the partial index, so it
    /// neither collides nor is pruned.
    #[test]
    fn insert_leaves_a_decided_row_holding_the_same_user_code() {
        let store = SqliteGrantStore::open_in_memory().expect("open in-memory store");
        let ten_minutes_ago = Utc::now() - Duration::minutes(10);
        let decided = device_with_status(
            device_request_at(
                "dev-denied",
                "SAME-CODE",
                ten_minutes_ago,
                Duration::minutes(5),
            ),
            RequestStatus::Denied,
        );
        insert_device(&store, &decided);
        insert_device(
            &store,
            &device_request_at("dev-new", "SAME-CODE", Utc::now(), Duration::minutes(5)),
        );
        assert!(stored(&store, "dev-denied").is_some());
        assert!(stored(&store, "dev-new").is_some());
    }

    /// The retention delete takes every row that expired before the cutoff,
    /// whatever its status, and nothing after it.
    #[test]
    fn delete_expired_requests_respects_the_cutoff() {
        let store = SqliteGrantStore::open_in_memory().expect("open in-memory store");
        let now = Utc::now();
        let old = now - Duration::days(10);
        insert_device(
            &store,
            &device_request_at("old", "UC-OLD", old, Duration::minutes(5)),
        );
        insert_device(
            &store,
            &device_with_status(
                device_request_at("old-claimed", "UC-CLAIMED", old, Duration::minutes(5)),
                RequestStatus::Claimed,
            ),
        );
        insert_device(&store, &device_request("recent"));
        let deleted = store
            .write(|tx| tx.delete_authorization_requests_expired_before(now - Duration::days(7)))
            .expect("delete");
        assert_eq!(deleted, 2);
        assert!(stored(&store, "old").is_none());
        assert!(stored(&store, "old-claimed").is_none());
        assert!(stored(&store, "recent").is_some());
    }

    /// A replace lands on the row with the status it was read with and
    /// writes the whole changed request; a second transition from the same
    /// stale read no longer lands, so of two decisions the first wins.
    #[test]
    fn a_replace_lands_only_while_the_row_has_the_status_it_was_read_with() {
        let store = SqliteGrantStore::open_in_memory().expect("open in-memory store");
        let now = Utc::now();
        let read = device_request("dev-1");
        insert_device(&store, &read);
        let approval = Approval {
            granted_scopes: vec!["openid".to_owned()],
            patient: Some("Patient/1".to_owned()),
        };
        let approved = read
            .approve(approval, Some("Kitchen iPad".to_owned()), now)
            .expect("approves");
        assert!(store
            .write(|tx| tx.replace_device_request(&read, &approved))
            .expect("replace"));
        assert_eq!(
            stored(&store, "dev-1"),
            Some(AuthorizationRequest::Device(approved.clone()))
        );

        let denied = read.deny(now).expect("the stale read still denies");
        assert!(
            !store
                .write(|tx| tx.replace_device_request(&read, &denied))
                .expect("replace"),
            "the approval won"
        );
        assert_eq!(
            stored(&store, "dev-1"),
            Some(AuthorizationRequest::Device(approved))
        );
    }

    /// The limited page's Continue and Cancel both read the request awaiting
    /// the page: the first to land moves its status on, and the other's
    /// replace doesn't land.
    #[test]
    fn a_cancel_racing_a_continue_on_the_limited_page_does_not_land() {
        let store = SqliteGrantStore::open_in_memory().expect("open in-memory store");
        let now = Utc::now();
        let read = code_request("req-1", true);
        insert_code(&store, &read);
        let continued = read
            .acknowledge_session_shortfall(Duration::minutes(5), now)
            .expect("continues");
        let cancelled = read.deny_on_limited_page(now).expect("cancels");
        assert!(store
            .write(|tx| tx.replace_code_request(&read, &continued))
            .expect("replace"));
        assert!(!store
            .write(|tx| tx.replace_code_request(&read, &cancelled))
            .expect("replace"));
        assert_eq!(
            stored(&store, "req-1").map(|request| request.status()),
            Some(RequestStatus::Pending)
        );
    }

    /// A poll stamp leaves the status as it was, so an approval read before
    /// it still lands (writing back the `last_polled_at` it read); a stamp
    /// read before an approval no longer does.
    #[test]
    fn approvals_never_fight_poll_stamps() {
        let store = SqliteGrantStore::open_in_memory().expect("open in-memory store");
        let now = Utc::now();
        let read = device_request("dev-1");
        insert_device(&store, &read);
        let approval = Approval {
            granted_scopes: vec!["openid".to_owned()],
            patient: None,
        };
        let replace = |changed: &DeviceRequest| {
            store
                .write(|tx| tx.replace_device_request(&read, changed))
                .expect("replace")
        };
        assert!(replace(&read.stamp_poll(now).expect("stamps")));
        assert!(replace(
            &read.approve(approval, None, now).expect("approves")
        ));
        assert!(!replace(&read.stamp_poll(now).expect("stamps")));
        let Some(AuthorizationRequest::Device(device)) = stored(&store, "dev-1") else {
            panic!("the device request is stored");
        };
        assert_eq!(device.state.status(), RequestStatus::Approved);
        assert_eq!(device.last_polled_at, None);
    }

    /// A replace on a row that isn't there lands nowhere; one whose changed
    /// request names another row is refused.
    #[test]
    fn a_replace_on_a_missing_or_another_row_does_not_land() {
        let store = SqliteGrantStore::open_in_memory().expect("open in-memory store");
        let ghost = device_request("ghost");
        let denied = ghost.deny(Utc::now()).expect("denies");
        assert!(!store
            .write(|tx| tx.replace_device_request(&ghost, &denied))
            .expect("replace"));
        assert!(stored(&store, "ghost").is_none());

        let victim = device_request("victim");
        insert_device(&store, &victim);
        assert!(store
            .write(|tx| tx.replace_device_request(&victim, &denied))
            .is_err());
        assert_eq!(
            stored(&store, "victim"),
            Some(AuthorizationRequest::Device(victim))
        );
    }

    /// A row missing a column its flow requires, whose approval columns
    /// disagree with its status, or in a status its flow never has, fails the
    /// read as malformed rather than reading as absent.
    #[test]
    fn a_malformed_row_fails_the_read() {
        for (id, tamper) in [
            (
                "req-1",
                "UPDATE authorization_requests SET redirect_uri = NULL WHERE id = 'req-1'",
            ),
            (
                "req-1",
                "UPDATE authorization_requests SET sid = NULL WHERE id = 'req-1'",
            ),
            (
                "req-1",
                "UPDATE authorization_requests SET grant_type = 'device_code' WHERE id = 'req-1'",
            ),
            (
                "req-1",
                "UPDATE authorization_requests SET grant_type = 'browser_pairing', \
                 user_code = 'UC' WHERE id = 'req-1'",
            ),
            (
                "req-1",
                "UPDATE authorization_requests SET status = 'approved' WHERE id = 'req-1'",
            ),
            (
                "req-1",
                "UPDATE authorization_requests SET granted_scopes = '[]' WHERE id = 'req-1'",
            ),
            (
                "req-1",
                "UPDATE authorization_requests SET patient = 'Patient/1' WHERE id = 'req-1'",
            ),
            (
                "req-1",
                "UPDATE authorization_requests SET status = 'claimed', granted_scopes = '[]' \
                 WHERE id = 'req-1'",
            ),
            (
                "dev-1",
                "UPDATE authorization_requests SET status = 'awaiting_limited_page' \
                 WHERE id = 'dev-1'",
            ),
            (
                "dev-1",
                "UPDATE authorization_requests SET grant_type = 'browser_pairing', \
                 status = 'approved', granted_scopes = '[]', patient = 'Patient/1', \
                 device_name = 'Laptop' WHERE id = 'dev-1'",
            ),
            (
                "dev-1",
                "UPDATE authorization_requests SET user_code = NULL WHERE id = 'dev-1'",
            ),
        ] {
            let store = SqliteGrantStore::open_in_memory().expect("open in-memory store");
            insert_code(&store, &code_request("req-1", false));
            insert_device(&store, &device_request("dev-1"));
            execute(&store, tamper);
            assert!(
                store.read(|tx| tx.authorization_request_by_id(id)).is_err(),
                "{tamper}"
            );
        }
    }

    /// The `status` and `grant_type` mappings reject an unknown stored
    /// discriminant on read as a typed error, never a panic.
    #[test]
    fn corrupt_enum_columns_are_typed_read_errors() {
        for column in ["status", "grant_type"] {
            let store = SqliteGrantStore::open_in_memory().expect("open in-memory store");
            insert_device(&store, &device_request("dev-1"));
            execute(
                &store,
                &format!("UPDATE authorization_requests SET {column} = 'bogus' WHERE id = 'dev-1'"),
            );
            assert!(
                store
                    .read(|tx| tx.authorization_request_by_id("dev-1"))
                    .is_err(),
                "a corrupt `{column}` must surface as a typed read error",
            );
        }
    }

    fn newest(store: &SqliteGrantStore) -> Option<OwnerPrompt> {
        store.read(|tx| tx.owner_prompt(Utc::now())).expect("query")
    }

    /// The newest pending request across every flow is the one the host is
    /// told of, its client named by its `client_id` until it is registered.
    #[test]
    fn owner_prompt_picks_the_newest_request_across_every_flow() {
        let store = SqliteGrantStore::open_in_memory().expect("open in-memory store");
        let now = Utc::now();
        insert_device(
            &store,
            &device_request_at(
                "dev-1",
                "UC-1",
                now - Duration::seconds(3),
                Duration::minutes(5),
            ),
        );
        assert_eq!(
            newest(&store),
            Some(OwnerPrompt::DeviceCode {
                user_code: "UC-1".to_owned(),
                client_name: "device-client".to_owned(),
            })
        );
        insert_code(&store, &code_request("req-1", false));
        assert_eq!(
            newest(&store),
            Some(OwnerPrompt::AuthorizationCode {
                id: "req-1".to_owned(),
                client_name: "app".to_owned(),
                decidable_in_requesting_browser: false,
            })
        );
        let pairing = PairingRequest::new(
            NewPairingRequestArgs {
                id: "pair-1".to_owned(),
                client_id: crate::BROWSER_SESSION_CLIENT_ID.to_owned(),
                requested_scopes: crate::owner_scopes(),
                ttl: Duration::minutes(5),
                user_code: "UC-2".to_owned(),
                browser_name: "Firefox on Linux".to_owned(),
            },
            now + Duration::seconds(1),
        );
        store
            .write(|tx| tx.insert_pairing_request(&pairing))
            .expect("insert");
        assert_eq!(
            newest(&store),
            Some(OwnerPrompt::BrowserPairing {
                user_code: "UC-2".to_owned(),
                browser_name: "Firefox on Linux".to_owned(),
            })
        );
    }

    /// Expired, decided, and still-on-the-limited-page requests are no
    /// candidates: the Owner isn't asked about a request its own browser
    /// hasn't gone on with.
    #[test]
    fn owner_prompt_skips_what_does_not_wait_for_the_owner() {
        let store = SqliteGrantStore::open_in_memory().expect("open in-memory store");
        let ten_minutes_ago = Utc::now() - Duration::minutes(10);
        insert_device(
            &store,
            &device_request_at("expired", "UC-1", ten_minutes_ago, Duration::minutes(5)),
        );
        insert_device(
            &store,
            &device_with_status(device_request("approved"), RequestStatus::Approved),
        );
        insert_code(
            &store,
            &code_with_status(code_request("denied", false), RequestStatus::Denied),
        );
        insert_code(&store, &code_request("on-limited-page", true));
        assert_eq!(newest(&store), None);
    }

    /// A disabled client's request is no candidate; a client with no row
    /// stays one.
    #[test]
    fn owner_prompt_skips_a_disabled_client() {
        let store = SqliteGrantStore::open_in_memory().expect("open in-memory store");
        let now = Utc::now();
        insert_device(
            &store,
            &device_request_at(
                "dev-1",
                "UC-1",
                now - Duration::seconds(3),
                Duration::minutes(5),
            ),
        );
        store
            .write(|tx| {
                tx.upsert_client(&Client {
                    disabled_at: Some(now),
                    ..client("app", &["read"])
                })
            })
            .expect("register disabled");
        insert_code(&store, &code_request("req-1", false));
        assert_eq!(
            newest(&store),
            Some(OwnerPrompt::DeviceCode {
                user_code: "UC-1".to_owned(),
                client_name: "device-client".to_owned(),
            })
        );
    }

    /// A registered client is named by its registered name.
    #[test]
    fn owner_prompt_names_a_registered_client_by_its_name() {
        let store = SqliteGrantStore::open_in_memory().expect("open in-memory store");
        store
            .write(|tx| tx.upsert_client(&client("app", &["read"])))
            .expect("register");
        insert_code(&store, &code_request("req-1", false));
        assert_eq!(
            newest(&store),
            Some(OwnerPrompt::AuthorizationCode {
                id: "req-1".to_owned(),
                client_name: "app display name".to_owned(),
                decidable_in_requesting_browser: false,
            })
        );
    }

    /// [`AuthorizationRequestsTx::is_awaiting_owner`], by each kind of
    /// [`ConsentKey`].
    mod is_awaiting_owner {
        use chrono::{DateTime, Duration, Utc};

        use crate::db::SqliteGrantStore;
        use crate::domain::authorization_request::RequestStatus;
        use crate::domain::consent_key::ConsentKey;
        use crate::domain::grant_store::*;
        use crate::domain::owner_prompt::OwnerPrompt;
        use crate::domain::test_fake::{code_request, device_request};

        fn awaiting(store: &SqliteGrantStore, key: &ConsentKey, now: DateTime<Utc>) -> bool {
            store.read(|tx| tx.is_awaiting_owner(key, now)).unwrap()
        }

        fn oauth(id: &str) -> ConsentKey {
            ConsentKey::AuthorizationCode { id: id.to_owned() }
        }

        fn device(user_code: &str) -> ConsentKey {
            ConsentKey::DeviceCode {
                user_code: user_code.to_owned(),
            }
        }

        /// A request awaits the Owner until it is decided or expires, and a
        /// code request still on its browser's limited page counts as
        /// undecided, as it waits there.
        #[test]
        fn a_request_awaits_the_owner_until_it_is_decided_or_expires() {
            let store = SqliteGrantStore::open_in_memory().expect("open in-memory store");
            let now = Utc::now();
            for (id, status, expires_at) in [
                (
                    "waiting",
                    RequestStatus::Pending,
                    now + Duration::minutes(5),
                ),
                (
                    "on-limited-page",
                    RequestStatus::AwaitingLimitedPage,
                    now + Duration::minutes(5),
                ),
                ("stale", RequestStatus::Pending, now - Duration::minutes(1)),
                (
                    "approved",
                    RequestStatus::Approved,
                    now + Duration::minutes(5),
                ),
                ("denied", RequestStatus::Denied, now + Duration::minutes(5)),
            ] {
                store
                    .write(|tx| tx.insert_code_request(&code_request(id, status, expires_at)))
                    .unwrap();
            }
            store
                .write(|tx| {
                    tx.insert_device_request(&device_request(
                        "device-waiting",
                        "ABCD-EFGH",
                        RequestStatus::Pending,
                    ))
                })
                .unwrap();
            store
                .write(|tx| {
                    tx.insert_device_request(&device_request(
                        "device-denied",
                        "WXYZ-WXYZ",
                        RequestStatus::Denied,
                    ))
                })
                .unwrap();

            let pending = |key: ConsentKey| awaiting(&store, &key, now);
            assert!(pending(oauth("waiting")));
            assert!(pending(oauth("on-limited-page")));
            assert!(pending(device("ABCD-EFGH")));
            assert!(!pending(oauth("stale")));
            assert!(!pending(oauth("approved")));
            assert!(!pending(oauth("denied")));
            assert!(!pending(device("WXYZ-WXYZ")));
            assert!(!pending(oauth("ghost")));
            assert!(!pending(device("GHST-GHST")));
            assert!(!pending(oauth("device-waiting")));
        }

        /// A disabled client's request does not await the Owner: `owner_prompt`
        /// skips it, and its key isn't awaiting; a client with no row stays a
        /// candidate.
        #[test]
        fn a_disabled_client_s_request_does_not_await_the_owner() {
            use crate::domain::client::Client;
            use crate::domain::test_fake::{client, code_request_for};

            let store = SqliteGrantStore::open_in_memory().expect("open in-memory store");
            let now = Utc::now();
            store
                .write(|tx| {
                    tx.insert_code_request(&code_request_for(
                        "unregistered",
                        "stranger",
                        vec!["read".to_owned()],
                    ))
                })
                .unwrap();
            assert!(awaiting(&store, &oauth("unregistered"), now));
            store
                .write(|tx| {
                    tx.upsert_client(&Client {
                        disabled_at: Some(now),
                        ..client("disabled-app", &["read"])
                    })
                })
                .unwrap();
            store
                .write(|tx| {
                    tx.insert_code_request(&code_request_for(
                        "disabled",
                        "disabled-app",
                        vec!["read".to_owned()],
                    ))
                })
                .unwrap();
            assert!(!awaiting(&store, &oauth("disabled"), now));
            assert!(matches!(
                store.read(|tx| tx.owner_prompt(now)).unwrap(),
                Some(OwnerPrompt::AuthorizationCode { id, .. }) if id == "unregistered"
            ));
        }
    }
}
