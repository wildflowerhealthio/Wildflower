//! The requests the Owner decides, in three tables by how a request is keyed:
//!
//! - `code_authorization_requests`: the code flow's, keyed by id;
//! - `user_code_requests`: device requests and browser pairings, keyed by
//!   the `user_code` the Owner enters and claimed by a poll, told apart by a
//!   `flow` column. Only this module knows they share a table;
//! - `session_widening_requests`: session widenings, keyed by id and claimed
//!   by a poll.
//!
//! Each table's row file (`code_request_row`, `user_code_request_row`,
//! `session_widening_request_row`) holds
//! its `table!`, its row struct, and the `TryFrom`
//! conversions that read a row into the flow's struct: the one place the
//! columns are checked against the flow and status, so a row whose approval
//! columns disagree with its status fails the read as malformed rather than
//! reading as absent. This file holds the queries: the
//! [`AuthorizationRequestsTx`] port on [`SqliteGrantTx`], with the reads that
//! cross flows reading both tables.

mod code_request_row;
mod session_widening_request_row;
mod user_code_request_row;

use chrono::{DateTime, Utc};
use diesel::prelude::*;

use code_request_row::{code_authorization_requests, CodeAuthorizationRequestRow};
use session_widening_request_row::{session_widening_requests, SessionWideningRequestRow};
use user_code_request_row::{user_code_requests, UserCodeRequestRow};

use crate::db::clients::clients;
use crate::db::grant_store::SqliteGrantTx;
use crate::db::shared::{text_enum_column, JsonStrings};
use crate::domain::authorization_request::approval::Approval;
use crate::domain::authorization_request::code::CodeRequest;
use crate::domain::authorization_request::device::DeviceRequest;
use crate::domain::authorization_request::pairing::PairingRequest;
use crate::domain::authorization_request::polled::PolledRequest;
use crate::domain::authorization_request::session_widening::SessionWideningRequest;
use crate::domain::authorization_request::{AuthorizationRequest, FlowType, RequestStatus};
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::consent_key::ConsentKey;
use crate::domain::grant_store::{AuthorizationRequestsTx, ClientsTx};
use crate::domain::owner_prompt::OwnerPrompt;

// The request `status` discriminant, stored as its strum wire string. Only the
// authorization requests bind it, so its mapping lives here.
text_enum_column!(RequestStatus);

/// The approval a row's `granted_scopes` and `patient` columns hold: present
/// exactly when `status` is approved or claimed, and a patient only beside
/// granted scopes. Any other combination is `malformed`.
fn approval_from_columns(
    status: RequestStatus,
    granted_scopes: Option<JsonStrings>,
    patient: Option<String>,
    malformed: impl FnOnce(&str) -> AuthorizationServerError,
) -> Result<Option<Approval>, AuthorizationServerError> {
    let carries_approval = matches!(status, RequestStatus::Approved | RequestStatus::Claimed);
    match (granted_scopes, patient) {
        (Some(granted_scopes), patient) if carries_approval => Ok(Some(Approval {
            granted_scopes: granted_scopes.0,
            patient,
        })),
        (None, None) if !carries_approval => Ok(None),
        _ => Err(malformed(&format!(
            "is {status} but its approval columns disagree"
        ))),
    }
}

/// `operation`'s failure, as the opaque infrastructure error.
fn failed(
    operation: &'static str,
) -> impl FnOnce(diesel::result::Error) -> AuthorizationServerError {
    move |error| AuthorizationServerError::infrastructure(operation, error)
}

/// A replace refused because `changed_id` names another row than `read_id`.
fn replaced_by_another(read_id: &str, changed_id: &str) -> AuthorizationServerError {
    AuthorizationServerError::infrastructure(
        "replace_authorization_request refused",
        format!("request {read_id} replaced by request {changed_id}"),
    )
}

/// A pending request the Owner prompt may show, with its client's registered
/// name.
type PromptCandidate = (AuthorizationRequest, Option<String>);

/// Of two prompt candidates, the later by `requested_at`; on a tie, `first`.
fn later_of(
    first: Option<PromptCandidate>,
    second: Option<PromptCandidate>,
) -> Option<PromptCandidate> {
    match (first, second) {
        (Some(first), Some(second)) if second.0.requested_at() > first.0.requested_at() => {
            Some(second)
        }
        (Some(first), _) => Some(first),
        (None, second) => second,
    }
}

impl SqliteGrantTx<'_> {
    /// The user-code request keyed `id` of `flow`, read into the flow's
    /// struct `R`.
    fn user_code_request_by_id<R: TryFrom<UserCodeRequestRow, Error = AuthorizationServerError>>(
        &mut self,
        id: &str,
        flow: FlowType,
        operation: &'static str,
    ) -> Result<Option<R>, AuthorizationServerError> {
        user_code_requests::table
            .find(id)
            .filter(user_code_requests::flow.eq(flow))
            .select(UserCodeRequestRow::as_select())
            .first(self.conn)
            .optional()
            .map_err(failed(operation))?
            .map(R::try_from)
            .transpose()
    }

    /// Insert a user-code request's `row`, first clearing an already-expired
    /// pending row holding its `user_code` (as of the request's start): that
    /// row occupies the partial unique index the insert would otherwise
    /// collide with. Bulk reclamation is the retention sweep's; see
    /// `authorization-server-rust/docs/Book/Domain/Retention Explanation.md`.
    fn insert_user_code_row(
        &mut self,
        row: &UserCodeRequestRow,
    ) -> Result<(), AuthorizationServerError> {
        diesel::delete(
            user_code_requests::table
                .filter(user_code_requests::user_code.eq(&row.user_code))
                .filter(user_code_requests::status.eq(RequestStatus::Pending))
                .filter(user_code_requests::expires_at.lt(row.requested_at)),
        )
        .execute(self.conn)
        .map_err(failed("insert_user_code_row failed"))?;
        diesel::insert_into(user_code_requests::table)
            .values(row)
            .execute(self.conn)
            .map_err(failed("insert_user_code_row failed"))?;
        Ok(())
    }

    /// One `UPDATE` of every column but the key to `changed`, guarded on the
    /// key, the flow and the status `read_status` the request was read with.
    fn replace_user_code_row(
        &mut self,
        read_id: &str,
        read_status: RequestStatus,
        changed: &UserCodeRequestRow,
    ) -> Result<bool, AuthorizationServerError> {
        if changed.id != read_id {
            return Err(replaced_by_another(read_id, &changed.id));
        }
        let affected = diesel::update(
            user_code_requests::table
                .find(read_id)
                .filter(user_code_requests::flow.eq(changed.flow))
                .filter(user_code_requests::status.eq(read_status)),
        )
        .set(changed)
        .execute(self.conn)
        .map_err(failed("replace_authorization_request failed"))?;
        Ok(affected == 1)
    }

    /// The newest pending, unexpired code request whose client isn't
    /// disabled; of two started at once, the greater id.
    fn newest_pending_code_request(
        &mut self,
        now: DateTime<Utc>,
    ) -> Result<Option<PromptCandidate>, AuthorizationServerError> {
        code_authorization_requests::table
            .left_join(
                clients::table.on(clients::client_id.eq(code_authorization_requests::client_id)),
            )
            .filter(code_authorization_requests::status.eq(RequestStatus::Pending))
            .filter(code_authorization_requests::expires_at.gt(now))
            .filter(clients::disabled_at.is_null())
            .order((
                code_authorization_requests::requested_at.desc(),
                code_authorization_requests::id.desc(),
            ))
            .select((
                CodeAuthorizationRequestRow::as_select(),
                clients::name.nullable(),
            ))
            .first::<(CodeAuthorizationRequestRow, Option<String>)>(self.conn)
            .optional()
            .map_err(failed("owner_prompt failed"))?
            .map(|(row, registered_client_name)| {
                Ok((
                    AuthorizationRequest::Code(CodeRequest::try_from(row)?),
                    registered_client_name,
                ))
            })
            .transpose()
    }

    /// The newest pending, unexpired device request or pairing whose client
    /// isn't disabled; of two started at once, the greater id.
    fn newest_pending_user_code_request(
        &mut self,
        now: DateTime<Utc>,
    ) -> Result<Option<PromptCandidate>, AuthorizationServerError> {
        user_code_requests::table
            .left_join(clients::table.on(clients::client_id.eq(user_code_requests::client_id)))
            .filter(user_code_requests::status.eq(RequestStatus::Pending))
            .filter(user_code_requests::expires_at.gt(now))
            .filter(clients::disabled_at.is_null())
            .order((
                user_code_requests::requested_at.desc(),
                user_code_requests::id.desc(),
            ))
            .select((UserCodeRequestRow::as_select(), clients::name.nullable()))
            .first::<(UserCodeRequestRow, Option<String>)>(self.conn)
            .optional()
            .map_err(failed("owner_prompt failed"))?
            .map(|(row, registered_client_name)| {
                Ok((
                    AuthorizationRequest::from(PolledRequest::try_from(row)?),
                    registered_client_name,
                ))
            })
            .transpose()
    }

    /// The newest pending, unexpired session widening whose app isn't
    /// disabled; of two started at once, the greater id.
    fn newest_pending_session_widening_request(
        &mut self,
        now: DateTime<Utc>,
    ) -> Result<Option<PromptCandidate>, AuthorizationServerError> {
        session_widening_requests::table
            .left_join(
                clients::table.on(clients::client_id.eq(session_widening_requests::client_id)),
            )
            .filter(session_widening_requests::status.eq(RequestStatus::Pending))
            .filter(session_widening_requests::expires_at.gt(now))
            .filter(clients::disabled_at.is_null())
            .order((
                session_widening_requests::requested_at.desc(),
                session_widening_requests::id.desc(),
            ))
            .select((
                SessionWideningRequestRow::as_select(),
                clients::name.nullable(),
            ))
            .first::<(SessionWideningRequestRow, Option<String>)>(self.conn)
            .optional()
            .map_err(failed("owner_prompt failed"))?
            .map(|(row, registered_client_name)| {
                Ok((
                    AuthorizationRequest::SessionWidening(SessionWideningRequest::try_from(row)?),
                    registered_client_name,
                ))
            })
            .transpose()
    }
}

impl AuthorizationRequestsTx for SqliteGrantTx<'_> {
    /// The code table first, then the session-widening table, then the
    /// user-code table.
    fn authorization_request_by_id(
        &mut self,
        id: &str,
    ) -> Result<Option<AuthorizationRequest>, AuthorizationServerError> {
        if let Some(code_request) = self.code_request_by_id(id)? {
            return Ok(Some(AuthorizationRequest::Code(code_request)));
        }
        if let Some(widening_request) = self.session_widening_request_by_id(id)? {
            return Ok(Some(AuthorizationRequest::SessionWidening(
                widening_request,
            )));
        }
        user_code_requests::table
            .find(id)
            .select(UserCodeRequestRow::as_select())
            .first(self.conn)
            .optional()
            .map_err(failed("authorization_request_by_id failed"))?
            .map(|row| PolledRequest::try_from(row).map(AuthorizationRequest::from))
            .transpose()
    }

    fn code_request_by_id(
        &mut self,
        id: &str,
    ) -> Result<Option<CodeRequest>, AuthorizationServerError> {
        code_authorization_requests::table
            .find(id)
            .select(CodeAuthorizationRequestRow::as_select())
            .first(self.conn)
            .optional()
            .map_err(failed("code_request_by_id failed"))?
            .map(CodeRequest::try_from)
            .transpose()
    }

    fn device_request_by_id(
        &mut self,
        device_code: &str,
    ) -> Result<Option<DeviceRequest>, AuthorizationServerError> {
        self.user_code_request_by_id(
            device_code,
            FlowType::DeviceCode,
            "device_request_by_id failed",
        )
    }

    fn pairing_request_by_id(
        &mut self,
        pairing_code: &str,
    ) -> Result<Option<PairingRequest>, AuthorizationServerError> {
        self.user_code_request_by_id(
            pairing_code,
            FlowType::BrowserPairing,
            "pairing_request_by_id failed",
        )
    }

    fn session_widening_request_by_id(
        &mut self,
        id: &str,
    ) -> Result<Option<SessionWideningRequest>, AuthorizationServerError> {
        session_widening_requests::table
            .find(id)
            .select(SessionWideningRequestRow::as_select())
            .first(self.conn)
            .optional()
            .map_err(failed("session_widening_request_by_id failed"))?
            .map(SessionWideningRequest::try_from)
            .transpose()
    }

    fn pending_session_widening_requests_for_session(
        &mut self,
        sid: &str,
        now: DateTime<Utc>,
    ) -> Result<Vec<SessionWideningRequest>, AuthorizationServerError> {
        session_widening_requests::table
            .filter(session_widening_requests::sid.eq(sid))
            .filter(session_widening_requests::status.eq(RequestStatus::Pending))
            .filter(session_widening_requests::expires_at.gt(now))
            .order((
                session_widening_requests::requested_at.desc(),
                session_widening_requests::id.desc(),
            ))
            .select(SessionWideningRequestRow::as_select())
            .load(self.conn)
            .map_err(failed(
                "pending_session_widening_requests_for_session failed",
            ))?
            .into_iter()
            .map(SessionWideningRequest::try_from)
            .collect()
    }

    fn polled_request_by_user_code(
        &mut self,
        user_code: &str,
    ) -> Result<Option<PolledRequest>, AuthorizationServerError> {
        user_code_requests::table
            .filter(user_code_requests::user_code.eq(user_code))
            .select(UserCodeRequestRow::as_select())
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
        user_code_requests::table
            .filter(user_code_requests::user_code.eq(user_code))
            .filter(user_code_requests::status.eq(RequestStatus::Pending))
            .select(UserCodeRequestRow::as_select())
            .first(self.conn)
            .optional()
            .map_err(failed("pending_polled_request_by_user_code failed"))?
            .map(PolledRequest::try_from)
            .transpose()
    }

    /// Three reads, the newest candidate from each table, keeping the latest
    /// by `requested_at` (on a tie, the code request, then the user-code
    /// request; within a table, the greater id). The client's name comes from its registration through a
    /// left join: a client trusted on first use has none until the Owner
    /// approves it. A disabled client's request is skipped, a client with no
    /// row's kept (the rule on [`OwnerPrompt`]). Only `pending` rows are
    /// candidates, so a code request still on its browser's limited page is
    /// none.
    fn owner_prompt(
        &mut self,
        now: DateTime<Utc>,
    ) -> Result<Option<OwnerPrompt>, AuthorizationServerError> {
        let code = self.newest_pending_code_request(now)?;
        let polled = self.newest_pending_user_code_request(now)?;
        let widening = self.newest_pending_session_widening_request(now)?;
        Ok(
            later_of(later_of(code, polled), widening).map(|(request, registered_client_name)| {
                OwnerPrompt::for_request(&request, registered_client_name)
            }),
        )
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
            ConsentKey::SessionWidening { id } => self
                .session_widening_request_by_id(id)?
                .map(AuthorizationRequest::SessionWidening),
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
        diesel::insert_into(code_authorization_requests::table)
            .values(CodeAuthorizationRequestRow::from(request))
            .execute(self.conn)
            .map_err(failed("insert_code_request failed"))?;
        Ok(())
    }

    fn insert_device_request(
        &mut self,
        request: &DeviceRequest,
    ) -> Result<(), AuthorizationServerError> {
        self.insert_user_code_row(&UserCodeRequestRow::from(request))
    }

    fn insert_session_widening_request(
        &mut self,
        request: &SessionWideningRequest,
    ) -> Result<(), AuthorizationServerError> {
        diesel::insert_into(session_widening_requests::table)
            .values(SessionWideningRequestRow::from(request))
            .execute(self.conn)
            .map_err(failed("insert_session_widening_request failed"))?;
        Ok(())
    }

    fn insert_pairing_request(
        &mut self,
        request: &PairingRequest,
    ) -> Result<(), AuthorizationServerError> {
        self.insert_user_code_row(&UserCodeRequestRow::from(request))
    }

    /// One `UPDATE` of every column but the key to `changed`, guarded on the
    /// key and the status `read` has.
    fn replace_code_request(
        &mut self,
        read: &CodeRequest,
        changed: &CodeRequest,
    ) -> Result<bool, AuthorizationServerError> {
        if changed.id != read.id {
            return Err(replaced_by_another(&read.id, &changed.id));
        }
        let affected = diesel::update(
            code_authorization_requests::table
                .find(&read.id)
                .filter(code_authorization_requests::status.eq(read.state.status())),
        )
        .set(CodeAuthorizationRequestRow::from(changed))
        .execute(self.conn)
        .map_err(failed("replace_authorization_request failed"))?;
        Ok(affected == 1)
    }

    fn replace_device_request(
        &mut self,
        read: &DeviceRequest,
        changed: &DeviceRequest,
    ) -> Result<bool, AuthorizationServerError> {
        self.replace_user_code_row(
            &read.id,
            read.state.status(),
            &UserCodeRequestRow::from(changed),
        )
    }

    fn replace_pairing_request(
        &mut self,
        read: &PairingRequest,
        changed: &PairingRequest,
    ) -> Result<bool, AuthorizationServerError> {
        self.replace_user_code_row(
            &read.id,
            read.state.status(),
            &UserCodeRequestRow::from(changed),
        )
    }

    /// One `UPDATE` of every column but the key to `changed`, guarded on the
    /// key and the status `read` has.
    fn replace_session_widening_request(
        &mut self,
        read: &SessionWideningRequest,
        changed: &SessionWideningRequest,
    ) -> Result<bool, AuthorizationServerError> {
        if changed.id != read.id {
            return Err(replaced_by_another(&read.id, &changed.id));
        }
        let affected = diesel::update(
            session_widening_requests::table
                .find(&read.id)
                .filter(session_widening_requests::status.eq(read.state.status())),
        )
        .set(SessionWideningRequestRow::from(changed))
        .execute(self.conn)
        .map_err(failed("replace_authorization_request failed"))?;
        Ok(affected == 1)
    }

    fn delete_code_requests_expired_before(
        &mut self,
        cutoff: DateTime<Utc>,
    ) -> Result<usize, AuthorizationServerError> {
        diesel::delete(
            code_authorization_requests::table
                .filter(code_authorization_requests::expires_at.lt(cutoff)),
        )
        .execute(self.conn)
        .map_err(failed("delete_code_requests_expired_before failed"))
    }

    fn delete_polled_requests_expired_before(
        &mut self,
        cutoff: DateTime<Utc>,
    ) -> Result<usize, AuthorizationServerError> {
        diesel::delete(user_code_requests::table.filter(user_code_requests::expires_at.lt(cutoff)))
            .execute(self.conn)
            .map_err(failed("delete_polled_requests_expired_before failed"))
    }

    fn delete_session_widening_requests_expired_before(
        &mut self,
        cutoff: DateTime<Utc>,
    ) -> Result<usize, AuthorizationServerError> {
        diesel::delete(
            session_widening_requests::table
                .filter(session_widening_requests::expires_at.lt(cutoff)),
        )
        .execute(self.conn)
        .map_err(failed(
            "delete_session_widening_requests_expired_before failed",
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
    use crate::domain::authorization_request::code::{CodeRequestState, NewCodeRequestArgs};
    use crate::domain::authorization_request::device::NewDeviceRequestArgs;
    use crate::domain::authorization_request::pairing::{NewPairingRequestArgs, PairingApproval};
    use crate::domain::authorization_request::polled::PolledState;
    use crate::domain::authorization_request::session_widening::{
        NewSessionWideningRequestArgs, SessionWideningApproval,
    };
    use crate::domain::client::Client;
    use crate::domain::grant_store::*;
    use crate::domain::test_fake::{
        client, code_with_status, device_with_status, fixture_code_args,
    };

    /// Up to four scope-like strings.
    fn arb_scopes() -> impl Strategy<Value = Vec<String>> {
        prop::collection::vec("[a-z][a-z0-9_]{0,15}", 0..5)
    }

    /// An approval of any scopes, binding a patient or not.
    fn arb_approval() -> impl Strategy<Value = Approval> {
        (arb_scopes(), prop::option::of("[a-zA-Z0-9-]{1,32}")).prop_map(
            |(granted_scopes, patient)| Approval {
                granted_scopes,
                patient,
            },
        )
    }

    /// Any polled state, its approval (when approved or claimed) drawn by
    /// `arb_approval`.
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
        /// A code request in any state, with every field drawn independently.
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
        /// A device request in any polled state, named or not.
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
        /// A browser pairing in any polled state; its approval binds no
        /// patient.
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

    prop_compose! {
        /// A session widening in any polled state.
        fn arb_session_widening_request()(
            id in "[a-zA-Z0-9_-]{1,40}",
            sid in "[a-z0-9-]{1,16}",
            client_id in "[a-zA-Z0-9_-]{1,32}",
            browser_name in "[ -~]{1,40}",
            requested_scopes in arb_scopes(),
            requested_at in arb_timestamp(),
            expires_at in arb_timestamp(),
            state in arb_polled_state(
                || arb_scopes().prop_map(|granted_scopes| SessionWideningApproval { granted_scopes })
            ),
        ) -> SessionWideningRequest {
            SessionWideningRequest {
                id,
                sid,
                client_id,
                browser_name,
                requested_scopes,
                requested_at,
                expires_at,
                state,
            }
        }
    }

    /// A request of any of the four flows.
    fn arb_authorization_request() -> impl Strategy<Value = AuthorizationRequest> {
        prop_oneof![
            arb_code_request().prop_map(AuthorizationRequest::Code),
            arb_device_request().prop_map(AuthorizationRequest::Device),
            arb_pairing_request().prop_map(AuthorizationRequest::Pairing),
            arb_session_widening_request().prop_map(AuthorizationRequest::SessionWidening),
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
            AuthorizationRequest::SessionWidening(widening_request) => {
                tx.insert_session_widening_request(widening_request)
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

    /// Insert the device request `request`, unwrapping the result.
    fn insert_device(store: &SqliteGrantStore, request: &DeviceRequest) {
        store
            .write(|tx| tx.insert_device_request(request))
            .expect("insert");
    }

    /// Insert the code request `request`, unwrapping the result.
    fn insert_code(store: &SqliteGrantStore, request: &CodeRequest) {
        store
            .write(|tx| tx.insert_code_request(request))
            .expect("insert");
    }

    /// The request `id` as stored now, of whichever flow.
    fn stored(store: &SqliteGrantStore, id: &str) -> Option<AuthorizationRequest> {
        store
            .read(|tx| tx.authorization_request_by_id(id))
            .expect("query")
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

    /// Each retention delete takes every row of its table that expired before
    /// the cutoff, whatever its status, and nothing after it or in the other
    /// table.
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
        insert_code(
            &store,
            &CodeRequest::new(
                NewCodeRequestArgs {
                    ttl: Duration::minutes(5),
                    ..fixture_code_args("old-code", "app", vec!["read".to_owned()])
                },
                old,
            ),
        );
        insert_code(&store, &code_request("recent-code", false));
        let cutoff = now - Duration::days(7);
        let deleted_polled = store
            .write(|tx| tx.delete_polled_requests_expired_before(cutoff))
            .expect("delete");
        assert_eq!(deleted_polled, 2);
        assert!(stored(&store, "old").is_none());
        assert!(stored(&store, "old-claimed").is_none());
        assert!(stored(&store, "recent").is_some());
        assert!(stored(&store, "old-code").is_some(), "another table's");
        let deleted_code = store
            .write(|tx| tx.delete_code_requests_expired_before(cutoff))
            .expect("delete");
        assert_eq!(deleted_code, 1);
        assert!(stored(&store, "old-code").is_none());
        assert!(stored(&store, "recent-code").is_some());
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
            .to_approved(approval, Some("Kitchen iPad".to_owned()), now)
            .expect("approves");
        assert!(store
            .write(|tx| tx.replace_device_request(&read, &approved))
            .expect("replace"));
        assert_eq!(
            stored(&store, "dev-1"),
            Some(AuthorizationRequest::Device(approved.clone()))
        );

        let denied = read.to_denied(now).expect("the stale read still denies");
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
            &read.to_approved(approval, None, now).expect("approves")
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
        let denied = ghost.to_denied(Utc::now()).expect("denies");
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

    /// Run raw SQL with the CHECK constraints off, to plant a row the schema
    /// refuses.
    fn execute_unchecked(store: &SqliteGrantStore, sql: &str) {
        use diesel::connection::SimpleConnection as _;
        let mut conn = store.pool().get().expect("check out a connection");
        conn.batch_execute(&format!(
            "PRAGMA ignore_check_constraints = ON; {sql}; PRAGMA ignore_check_constraints = OFF;"
        ))
        .expect("raw SQL");
    }

    /// A row whose approval columns disagree with its status, in a status its
    /// flow never has, or with a column its flow requires missing, is refused
    /// by the schema's CHECKs; and if one were there anyway, it fails the read
    /// as malformed rather than reading as absent.
    #[test]
    fn a_malformed_row_fails_the_read() {
        for (id, tamper) in [
            (
                "req-1",
                "UPDATE code_authorization_requests SET status = 'approved' WHERE id = 'req-1'",
            ),
            (
                "req-1",
                "UPDATE code_authorization_requests SET granted_scopes = '[]' WHERE id = 'req-1'",
            ),
            (
                "req-1",
                "UPDATE code_authorization_requests SET patient = 'Patient/1' WHERE id = 'req-1'",
            ),
            (
                "req-1",
                "UPDATE code_authorization_requests SET status = 'claimed', granted_scopes = '[]' \
                 WHERE id = 'req-1'",
            ),
            (
                "dev-1",
                "UPDATE user_code_requests SET status = 'awaiting_limited_page' WHERE id = 'dev-1'",
            ),
            (
                "dev-1",
                "UPDATE user_code_requests SET flow = 'authorization_code' WHERE id = 'dev-1'",
            ),
            (
                "dev-1",
                "UPDATE user_code_requests SET flow = 'browser_pairing' WHERE id = 'dev-1'",
            ),
            (
                "dev-1",
                "UPDATE user_code_requests SET flow = 'browser_pairing', \
                 status = 'approved', granted_scopes = '[]', patient = 'Patient/1', \
                 device_name = 'Laptop' WHERE id = 'dev-1'",
            ),
            (
                "dev-1",
                "UPDATE user_code_requests SET status = 'approved' WHERE id = 'dev-1'",
            ),
        ] {
            let store = SqliteGrantStore::open_in_memory().expect("open in-memory store");
            insert_code(&store, &code_request("req-1", false));
            insert_device(&store, &device_request("dev-1"));
            let mut conn = store.pool().get().expect("check out a connection");
            assert!(
                diesel::sql_query(tamper).execute(&mut conn).is_err(),
                "the schema refuses {tamper}"
            );
            drop(conn);
            execute_unchecked(&store, tamper);
            assert!(
                store.read(|tx| tx.authorization_request_by_id(id)).is_err(),
                "{tamper}"
            );
        }
    }

    /// The `status` and `flow` mappings reject an unknown stored discriminant
    /// (planted past the CHECKs) on read as a typed error, never a panic.
    #[test]
    fn corrupt_enum_columns_are_typed_read_errors() {
        for (table, column, id) in [
            ("user_code_requests", "status", "dev-1"),
            ("user_code_requests", "flow", "dev-1"),
            ("code_authorization_requests", "status", "req-1"),
        ] {
            let store = SqliteGrantStore::open_in_memory().expect("open in-memory store");
            insert_device(&store, &device_request("dev-1"));
            insert_code(&store, &code_request("req-1", false));
            execute_unchecked(
                &store,
                &format!("UPDATE {table} SET {column} = 'bogus' WHERE id = '{id}'"),
            );
            assert!(
                store.read(|tx| tx.authorization_request_by_id(id)).is_err(),
                "a corrupt `{table}.{column}` must surface as a typed read error",
            );
        }
    }

    /// The Owner prompt as of now.
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
        let widening = SessionWideningRequest::new(
            NewSessionWideningRequestArgs {
                id: "widen-1".to_owned(),
                sid: "sid-1".to_owned(),
                client_id: "app".to_owned(),
                browser_name: "Safari on iOS".to_owned(),
                requested_scopes: vec!["wildflower/Apps.r".to_owned()],
                ttl: Duration::minutes(5),
            },
            now + Duration::seconds(2),
        );
        store
            .write(|tx| tx.insert_session_widening_request(&widening))
            .expect("insert");
        assert_eq!(
            newest(&store),
            Some(OwnerPrompt::SessionWidening {
                id: "widen-1".to_owned(),
                browser_name: "Safari on iOS".to_owned(),
            })
        );
        assert!(store
            .read(|tx| tx.is_awaiting_owner(
                &ConsentKey::SessionWidening {
                    id: "widen-1".to_owned()
                },
                Utc::now()
            ))
            .expect("query"));
        let denied = widening.to_denied(Utc::now()).expect("denies");
        assert!(store
            .write(|tx| tx.replace_session_widening_request(&widening, &denied))
            .expect("replace"));
        assert!(!store
            .read(|tx| tx.is_awaiting_owner(
                &ConsentKey::SessionWidening {
                    id: "widen-1".to_owned()
                },
                Utc::now()
            ))
            .expect("query"));
        assert!(!store
            .write(|tx| tx.replace_session_widening_request(&widening, &denied))
            .expect("replace"));
    }

    /// A session's widenings still waiting for the Owner are listed newest
    /// first; a decided one, an expired one and another session's are not.
    #[test]
    fn pending_session_widenings_are_the_session_s_undecided_unexpired_ones() {
        let store = SqliteGrantStore::open_in_memory().expect("open in-memory store");
        let now = Utc::now();
        let widening = |id: &str, sid: &str, asked_at: DateTime<Utc>| {
            SessionWideningRequest::new(
                NewSessionWideningRequestArgs {
                    id: id.to_owned(),
                    sid: sid.to_owned(),
                    client_id: "app".to_owned(),
                    browser_name: "Firefox on Linux".to_owned(),
                    requested_scopes: vec!["wildflower/Apps.r".to_owned()],
                    ttl: Duration::minutes(5),
                },
                asked_at,
            )
        };
        let older = widening("older", "sid-1", now - Duration::minutes(2));
        let newer = widening("newer", "sid-1", now - Duration::minutes(1));
        let denied = widening("denied", "sid-1", now);
        let expired = widening("expired", "sid-1", now - Duration::minutes(6));
        let other = widening("other", "sid-2", now);
        for request in [&older, &newer, &denied, &expired, &other] {
            store
                .write(|tx| tx.insert_session_widening_request(request))
                .expect("insert");
        }
        let denial = denied.to_denied(now).expect("denies");
        assert!(store
            .write(|tx| tx.replace_session_widening_request(&denied, &denial))
            .expect("replace"));
        assert_eq!(
            store
                .read(|tx| tx.pending_session_widening_requests_for_session("sid-1", now))
                .expect("query"),
            [newer, older]
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

    /// Of a code request and a device request started at the same instant, the
    /// prompt keeps the code request; of two started at once in one table, the
    /// greater id.
    #[test]
    fn owner_prompt_breaks_a_tie_deterministically() {
        let store = SqliteGrantStore::open_in_memory().expect("open in-memory store");
        let now = Utc::now();
        let code_at = |id: &str| {
            CodeRequest::new(
                NewCodeRequestArgs {
                    ttl: Duration::minutes(5),
                    ..fixture_code_args(id, "app", vec!["read".to_owned()])
                },
                now,
            )
        };
        insert_device(
            &store,
            &device_request_at("dev-1", "UC-1", now, Duration::minutes(5)),
        );
        insert_device(
            &store,
            &device_request_at("dev-2", "UC-2", now, Duration::minutes(5)),
        );
        assert_eq!(
            newest(&store),
            Some(OwnerPrompt::DeviceCode {
                user_code: "UC-2".to_owned(),
                client_name: "device-client".to_owned(),
            })
        );
        insert_code(&store, &code_at("req-1"));
        insert_code(&store, &code_at("req-2"));
        assert_eq!(
            newest(&store),
            Some(OwnerPrompt::AuthorizationCode {
                id: "req-2".to_owned(),
                client_name: "app".to_owned(),
                decidable_in_requesting_browser: false,
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

        /// Whether the request `key` names awaits the Owner at `now`.
        fn awaiting(store: &SqliteGrantStore, key: &ConsentKey, now: DateTime<Utc>) -> bool {
            store.read(|tx| tx.is_awaiting_owner(key, now)).unwrap()
        }

        /// The consent key of the code request `id`.
        fn oauth(id: &str) -> ConsentKey {
            ConsentKey::AuthorizationCode { id: id.to_owned() }
        }

        /// The consent key of the device request holding `user_code`.
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
