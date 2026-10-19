//! `authorization_requests` — the requests the Owner decides, stored one row
//! per request with a column for every kind's fields. The row is diesel-mapped
//! as the private [`Row`], and restored to an [`AuthorizationRequest`] by kind:
//! a row missing a field its kind requires (a code row without its redirect, a
//! device row without its user code) fails the read as malformed rather than
//! reading as absent.

use chrono::{DateTime, Utc};
use diesel::prelude::*;

use crate::db::clients::clients;
use crate::db::grant_store::SqliteGrantTx;
use crate::db::shared::{text_enum_column, JsonStrings, UrlText};
use crate::domain::authorization_request::{
    Approval, AuthorizationRequest, CodeRequest, DeviceRequest, GrantType, PairingRequest,
    RequestKind, RequestStatus, RequestTransition, StoredAuthorizationRequest,
};
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::grant_store::AuthorizationRequestsTx;
use crate::domain::pending_consent::NewestPendingConsent;

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
        session_shortfall_acknowledged -> Bool,
    }
}

diesel::allow_tables_to_appear_in_same_query!(authorization_requests, clients);

// The request `status` discriminant, stored as its strum wire string. Only the
// authorization request binds it, so its mapping lives here.
text_enum_column!(RequestStatus);

/// One `authorization_requests` row, every kind's columns side by side. A
/// browser pairing keeps its browser's name in `device_name`, the column the
/// device page reads a requester's name from.
#[derive(Queryable, Selectable, Insertable, AsChangeset)]
#[diesel(table_name = authorization_requests)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
#[diesel(treat_none_as_null = true)]
struct Row {
    id: String,
    grant_type: GrantType,
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
    session_shortfall_acknowledged: bool,
}

impl TryFrom<Row> for AuthorizationRequest {
    type Error = AuthorizationServerError;

    fn try_from(row: Row) -> Result<Self, Self::Error> {
        let Row {
            id,
            grant_type,
            client_id,
            requested_scopes,
            code_challenge,
            redirect_uri,
            client_state,
            user_code,
            pre_approved_scopes,
            requested_at,
            expires_at,
            last_polled_at,
            status,
            granted_scopes,
            patient,
            device_name,
            launch,
            launch_bound_patient,
            decidable_in_requesting_browser,
            sid,
            session_shortfall_acknowledged,
        } = row;
        let missing = |column: &str| malformed_row(&id, grant_type, column);
        let kind = match grant_type {
            GrantType::AuthorizationCode => RequestKind::AuthorizationCode(CodeRequest {
                redirect_uri: redirect_uri.ok_or_else(|| missing("redirect_uri"))?.0,
                code_challenge: code_challenge.ok_or_else(|| missing("code_challenge"))?,
                client_state: client_state.ok_or_else(|| missing("client_state"))?,
                sid: sid.ok_or_else(|| missing("sid"))?,
                launch,
                launch_bound_patient,
                pre_approved_scopes: pre_approved_scopes.0,
                decidable_in_requesting_browser,
                session_shortfall_acknowledged,
            }),
            GrantType::DeviceCode => RequestKind::DeviceCode(DeviceRequest {
                user_code: user_code.ok_or_else(|| missing("user_code"))?,
                device_name,
                last_polled_at,
            }),
            GrantType::BrowserPairing => RequestKind::BrowserPairing(PairingRequest {
                user_code: user_code.ok_or_else(|| missing("user_code"))?,
                browser_name: device_name.ok_or_else(|| missing("device_name"))?,
                last_polled_at,
            }),
        };
        AuthorizationRequest::restore(StoredAuthorizationRequest {
            id,
            client_id,
            requested_scopes: requested_scopes.0,
            requested_at,
            expires_at,
            status,
            approval: granted_scopes.map(|granted_scopes| Approval {
                granted_scopes: granted_scopes.0,
                patient,
            }),
            kind,
        })
        .map_err(|inconsistent| {
            AuthorizationServerError::infrastructure(
                "malformed authorization request row",
                inconsistent,
            )
        })
    }
}

/// The read failure for the row `id`, of `grant_type`, missing `column`.
fn malformed_row(id: &str, grant_type: GrantType, column: &str) -> AuthorizationServerError {
    AuthorizationServerError::infrastructure(
        "malformed authorization request row",
        format!("{grant_type} request {id} has no {column}"),
    )
}

impl From<&AuthorizationRequest> for Row {
    fn from(request: &AuthorizationRequest) -> Self {
        let approval = request.approval();
        let mut row = Row {
            id: request.id().to_owned(),
            grant_type: request.grant_type(),
            client_id: request.client_id().to_owned(),
            requested_scopes: JsonStrings(request.requested_scopes().to_vec()),
            code_challenge: None,
            redirect_uri: None,
            client_state: None,
            user_code: request.user_code().map(str::to_owned),
            pre_approved_scopes: JsonStrings(Vec::new()),
            requested_at: request.requested_at(),
            expires_at: request.expires_at(),
            last_polled_at: None,
            status: request.status(),
            granted_scopes: approval.map(|approval| JsonStrings(approval.granted_scopes.clone())),
            patient: approval.and_then(|approval| approval.patient.clone()),
            device_name: None,
            launch: None,
            launch_bound_patient: None,
            decidable_in_requesting_browser: false,
            sid: None,
            session_shortfall_acknowledged: true,
        };
        match request.kind() {
            RequestKind::AuthorizationCode(code_request) => Row {
                code_challenge: Some(code_request.code_challenge.clone()),
                redirect_uri: Some(UrlText(code_request.redirect_uri.clone())),
                client_state: Some(code_request.client_state.clone()),
                pre_approved_scopes: JsonStrings(code_request.pre_approved_scopes.clone()),
                launch: code_request.launch.clone(),
                launch_bound_patient: code_request.launch_bound_patient.clone(),
                decidable_in_requesting_browser: code_request.decidable_in_requesting_browser,
                sid: Some(code_request.sid.clone()),
                session_shortfall_acknowledged: code_request.session_shortfall_acknowledged,
                ..row
            },
            RequestKind::DeviceCode(device_request) => {
                row.device_name = device_request.device_name.clone();
                row.last_polled_at = device_request.last_polled_at;
                row
            }
            RequestKind::BrowserPairing(pairing_request) => {
                row.device_name = Some(pairing_request.browser_name.clone());
                row.last_polled_at = pairing_request.last_polled_at;
                row
            }
        }
    }
}

/// The request a selected row holds, or `None` for no row.
fn restored(row: Option<Row>) -> Result<Option<AuthorizationRequest>, AuthorizationServerError> {
    row.map(AuthorizationRequest::try_from).transpose()
}

impl AuthorizationRequestsTx for SqliteGrantTx<'_> {
    fn authorization_request_by_id(
        &mut self,
        id: &str,
    ) -> Result<Option<AuthorizationRequest>, AuthorizationServerError> {
        let row = authorization_requests::table
            .find(id)
            .select(Row::as_select())
            .first(self.conn)
            .optional()
            .map_err(|e| {
                AuthorizationServerError::infrastructure("authorization_request_by_id failed", e)
            })?;
        restored(row)
    }

    fn authorization_request_by_user_code(
        &mut self,
        user_code: &str,
    ) -> Result<Option<AuthorizationRequest>, AuthorizationServerError> {
        let row = authorization_requests::table
            .filter(authorization_requests::user_code.eq(user_code))
            .select(Row::as_select())
            .first(self.conn)
            .optional()
            .map_err(|e| {
                AuthorizationServerError::infrastructure(
                    "authorization_request_by_user_code failed",
                    e,
                )
            })?;
        restored(row)
    }

    fn pending_authorization_request_by_user_code(
        &mut self,
        user_code: &str,
    ) -> Result<Option<AuthorizationRequest>, AuthorizationServerError> {
        let row = authorization_requests::table
            .filter(authorization_requests::user_code.eq(user_code))
            .filter(authorization_requests::status.eq(RequestStatus::Pending))
            .select(Row::as_select())
            .first(self.conn)
            .optional()
            .map_err(|e| {
                AuthorizationServerError::infrastructure(
                    "pending_authorization_request_by_user_code failed",
                    e,
                )
            })?;
        restored(row)
    }

    /// The client's name comes from its registration through a left join: a
    /// client trusted on first use has none until the Owner approves it. A
    /// disabled client's request is skipped, a client with no row's kept (the
    /// rule on [`NewestPendingConsent`]).
    fn newest_pending_consent(
        &mut self,
        now: DateTime<Utc>,
    ) -> Result<Option<NewestPendingConsent>, AuthorizationServerError> {
        let row = authorization_requests::table
            .left_join(clients::table.on(clients::client_id.eq(authorization_requests::client_id)))
            .filter(authorization_requests::status.eq(RequestStatus::Pending))
            .filter(authorization_requests::expires_at.gt(now))
            .filter(authorization_requests::session_shortfall_acknowledged.eq(true))
            .filter(clients::disabled_at.is_null())
            .order(authorization_requests::requested_at.desc())
            .select((Row::as_select(), clients::name.nullable()))
            .first::<(Row, Option<String>)>(self.conn)
            .optional()
            .map_err(|e| {
                AuthorizationServerError::infrastructure("newest_pending_consent failed", e)
            })?;
        row.map(|(row, registered_client_name)| {
            let request = AuthorizationRequest::try_from(row)?;
            Ok(NewestPendingConsent::for_request(
                &request,
                registered_client_name,
            ))
        })
        .transpose()
    }

    /// An already-expired pending row holding this request's `user_code` (as
    /// of the request's start) is deleted first: it occupies the partial
    /// unique index the insert would otherwise collide with. Bulk reclamation
    /// is the retention sweep's; see `authorization-server-rust/docs/Retention
    /// Explanation.md`.
    fn insert_authorization_request(
        &mut self,
        request: &AuthorizationRequest,
    ) -> Result<(), AuthorizationServerError> {
        let as_infrastructure_error =
            |e| AuthorizationServerError::infrastructure("insert_authorization_request failed", e);
        if let Some(user_code) = request.user_code() {
            diesel::delete(
                authorization_requests::table
                    .filter(authorization_requests::user_code.eq(user_code))
                    .filter(authorization_requests::status.eq(RequestStatus::Pending))
                    .filter(authorization_requests::expires_at.lt(request.requested_at())),
            )
            .execute(self.conn)
            .map_err(as_infrastructure_error)?;
        }
        diesel::insert_into(authorization_requests::table)
            .values(Row::from(request))
            .execute(self.conn)
            .map_err(as_infrastructure_error)?;
        Ok(())
    }

    /// One `UPDATE` of every column but the key, guarded on the key and the
    /// phase the request was read in.
    fn replace_authorization_request(
        &mut self,
        transition: &RequestTransition,
    ) -> Result<bool, AuthorizationServerError> {
        let read_in = transition.read_in();
        let row = Row::from(transition.request());
        let affected = diesel::update(
            authorization_requests::table
                .find(&row.id)
                .filter(authorization_requests::status.eq(read_in.status))
                .filter(
                    authorization_requests::session_shortfall_acknowledged
                        .eq(read_in.session_shortfall_acknowledged),
                ),
        )
        .set(&row)
        .execute(self.conn)
        .map_err(|e| {
            AuthorizationServerError::infrastructure("replace_authorization_request failed", e)
        })?;
        Ok(affected == 1)
    }

    fn delete_authorization_requests_expired_before(
        &mut self,
        cutoff: DateTime<Utc>,
    ) -> Result<usize, AuthorizationServerError> {
        diesel::delete(
            authorization_requests::table.filter(authorization_requests::expires_at.lt(cutoff)),
        )
        .execute(self.conn)
        .map_err(|e| {
            AuthorizationServerError::infrastructure(
                "delete_authorization_requests_expired_before failed",
                e,
            )
        })
    }
}

#[cfg(test)]
mod tests {
    use chrono::Duration;
    use proptest::prelude::*;

    use super::*;
    use crate::db::test_support::{arb_opt_timestamp, arb_timestamp, arb_url};
    use crate::db::SqliteGrantStore;
    use crate::domain::authorization_request::NewAuthorizationRequest;
    use crate::domain::client::Client;
    use crate::domain::grant_store::*;
    use crate::domain::test_fake::{client, fixture_code, with_status};

    fn arb_scopes() -> impl Strategy<Value = Vec<String>> {
        prop::collection::vec("[a-z][a-z0-9_]{0,15}", 0..5)
    }

    fn arb_kind() -> impl Strategy<Value = RequestKind> {
        prop_oneof![
            (
                arb_url(),
                "[A-Za-z0-9_-]{43}",
                "[A-Za-z0-9_-]{1,32}",
                "[a-z0-9-]{1,16}",
                prop::option::of("[A-Za-z0-9_-]{43}"),
                prop::option::of("[a-zA-Z0-9-]{1,32}"),
                arb_scopes(),
                any::<bool>(),
                any::<bool>(),
            )
                .prop_map(
                    |(
                        redirect_uri,
                        code_challenge,
                        client_state,
                        sid,
                        launch,
                        launch_bound_patient,
                        pre_approved_scopes,
                        decidable_in_requesting_browser,
                        session_shortfall_acknowledged,
                    )| {
                        RequestKind::AuthorizationCode(CodeRequest {
                            redirect_uri,
                            code_challenge,
                            client_state,
                            sid,
                            launch,
                            launch_bound_patient,
                            pre_approved_scopes,
                            decidable_in_requesting_browser,
                            session_shortfall_acknowledged,
                        })
                    }
                ),
            (
                "[A-Z0-9-]{1,16}",
                prop::option::of("[ -~]{1,40}"),
                arb_opt_timestamp()
            )
                .prop_map(|(user_code, device_name, last_polled_at)| {
                    RequestKind::DeviceCode(DeviceRequest {
                        user_code,
                        device_name,
                        last_polled_at,
                    })
                }),
            ("[A-Z0-9-]{1,16}", "[ -~]{1,40}", arb_opt_timestamp()).prop_map(
                |(user_code, browser_name, last_polled_at)| {
                    RequestKind::BrowserPairing(PairingRequest {
                        user_code,
                        browser_name,
                        last_polled_at,
                    })
                }
            ),
        ]
    }

    /// A status with an approval exactly when it is approved or claimed.
    fn arb_status_and_approval() -> impl Strategy<Value = (RequestStatus, Option<Approval>)> {
        let arb_approval = || {
            (arb_scopes(), prop::option::of("[a-zA-Z0-9-]{1,32}")).prop_map(
                |(granted_scopes, patient)| Approval {
                    granted_scopes,
                    patient,
                },
            )
        };
        prop_oneof![
            Just((RequestStatus::Pending, None)),
            Just((RequestStatus::Denied, None)),
            arb_approval().prop_map(|approval| (RequestStatus::Approved, Some(approval))),
            arb_approval().prop_map(|approval| (RequestStatus::Claimed, Some(approval))),
        ]
    }

    prop_compose! {
        fn arb_authorization_request()(
            id in "[a-zA-Z0-9_-]{1,40}",
            client_id in "[a-zA-Z0-9_-]{1,32}",
            requested_scopes in arb_scopes(),
            requested_at in arb_timestamp(),
            expires_at in arb_timestamp(),
            (status, approval) in arb_status_and_approval(),
            kind in arb_kind(),
        ) -> AuthorizationRequest {
            AuthorizationRequest::restore(StoredAuthorizationRequest {
                id,
                client_id,
                requested_scopes,
                requested_at,
                expires_at,
                status,
                approval,
                kind,
            })
            .expect("a consistent approval")
        }
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(64))]

        /// Every kind, in every status, reads back exactly as it was written.
        #[test]
        fn insert_and_fetch_round_trip(request in arb_authorization_request()) {
            let store = SqliteGrantStore::open_in_memory().expect("open in-memory store");
            store
                .write(|tx| tx.insert_authorization_request(&request))
                .expect("insert");
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
    ) -> AuthorizationRequest {
        AuthorizationRequest::new(
            NewAuthorizationRequest {
                id: id.to_owned(),
                client_id: "device-client".to_owned(),
                requested_scopes: vec!["openid".to_owned()],
                ttl,
                kind: RequestKind::DeviceCode(DeviceRequest {
                    user_code: user_code.to_owned(),
                    device_name: None,
                    last_polled_at: None,
                }),
            },
            now,
        )
    }

    /// A pending device request `id`, keyed by `UC-{id}`, live for five
    /// minutes.
    fn device_request(id: &str) -> AuthorizationRequest {
        device_request_at(id, &format!("UC-{id}"), Utc::now(), Duration::minutes(5))
    }

    /// A pending code request `id` from `app`, live for five minutes, its
    /// browser past its limited page.
    fn code_request(id: &str) -> AuthorizationRequest {
        AuthorizationRequest::new(
            NewAuthorizationRequest {
                id: id.to_owned(),
                client_id: "app".to_owned(),
                requested_scopes: vec!["read".to_owned()],
                ttl: Duration::minutes(5),
                kind: RequestKind::AuthorizationCode(fixture_code()),
            },
            Utc::now(),
        )
    }

    fn insert(store: &SqliteGrantStore, request: &AuthorizationRequest) {
        store
            .write(|tx| tx.insert_authorization_request(request))
            .expect("insert");
    }

    fn stored(store: &SqliteGrantStore, id: &str) -> Option<AuthorizationRequest> {
        store
            .read(|tx| tx.authorization_request_by_id(id))
            .expect("query")
    }

    fn replace(store: &SqliteGrantStore, transition: &RequestTransition) -> bool {
        store
            .write(|tx| tx.replace_authorization_request(transition))
            .expect("replace")
    }

    /// Run raw SQL against the store's database, to plant a row no flow
    /// writes.
    fn execute(store: &SqliteGrantStore, sql: &str) {
        let mut conn = store.pool().get().expect("check out a connection");
        diesel::sql_query(sql).execute(&mut conn).expect("raw SQL");
    }

    /// An insert leaves an unrelated expired row for the retention sweep, so
    /// the window is the only thing that decides when it goes.
    #[test]
    fn insert_leaves_unrelated_expired_requests_for_the_sweep() {
        let store = SqliteGrantStore::open_in_memory().expect("open in-memory store");
        let ten_minutes_ago = Utc::now() - Duration::minutes(10);
        insert(
            &store,
            &device_request_at("expired-1", "UC-1", ten_minutes_ago, Duration::minutes(5)),
        );
        insert(&store, &device_request("fresh-1"));
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
        insert(
            &store,
            &device_request_at(
                "dev-stale",
                "SAME-CODE",
                ten_minutes_ago,
                Duration::minutes(5),
            ),
        );
        insert(
            &store,
            &device_request_at("dev-new", "SAME-CODE", Utc::now(), Duration::minutes(5)),
        );
        assert!(stored(&store, "dev-stale").is_none());
        assert!(stored(&store, "dev-new").is_some());
    }

    /// A live pending request holding the code is never dropped to make
    /// room: a collision on a live code stays a hard error.
    #[test]
    fn insert_never_drops_a_live_row_holding_the_same_user_code() {
        let store = SqliteGrantStore::open_in_memory().expect("open in-memory store");
        insert(
            &store,
            &device_request_at("dev-live", "SAME-CODE", Utc::now(), Duration::minutes(5)),
        );
        let colliding = device_request_at("dev-new", "SAME-CODE", Utc::now(), Duration::minutes(5));
        assert!(store
            .write(|tx| tx.insert_authorization_request(&colliding))
            .is_err());
        assert!(stored(&store, "dev-live").is_some());
    }

    /// A decided row holding the code is outside the partial index, so it
    /// neither collides nor is pruned.
    #[test]
    fn insert_leaves_a_decided_row_holding_the_same_user_code() {
        let store = SqliteGrantStore::open_in_memory().expect("open in-memory store");
        let ten_minutes_ago = Utc::now() - Duration::minutes(10);
        let decided = with_status(
            device_request_at(
                "dev-denied",
                "SAME-CODE",
                ten_minutes_ago,
                Duration::minutes(5),
            ),
            RequestStatus::Denied,
        );
        insert(&store, &decided);
        insert(
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
        insert(
            &store,
            &device_request_at("old", "UC-OLD", old, Duration::minutes(5)),
        );
        insert(
            &store,
            &with_status(
                device_request_at("old-claimed", "UC-CLAIMED", old, Duration::minutes(5)),
                RequestStatus::Claimed,
            ),
        );
        insert(&store, &device_request("recent"));
        let deleted = store
            .write(|tx| tx.delete_authorization_requests_expired_before(now - Duration::days(7)))
            .expect("delete");
        assert_eq!(deleted, 2);
        assert!(stored(&store, "old").is_none());
        assert!(stored(&store, "old-claimed").is_none());
        assert!(stored(&store, "recent").is_some());
    }

    /// A transition lands on the row in the phase it was read in and writes
    /// the whole transitioned request; a second transition from the same
    /// stale read no longer lands, so of two decisions the first wins.
    #[test]
    fn a_transition_lands_only_in_the_phase_it_was_read_in() {
        let store = SqliteGrantStore::open_in_memory().expect("open in-memory store");
        let now = Utc::now();
        let read = device_request("dev-1");
        insert(&store, &read);
        let approval = Approval {
            granted_scopes: vec!["openid".to_owned()],
            patient: Some("Patient/1".to_owned()),
        };
        let approved = read
            .approve_device(approval, Some("Kitchen iPad".to_owned()), now)
            .expect("approves");
        assert!(replace(&store, &approved));
        assert_eq!(stored(&store, "dev-1").as_ref(), Some(approved.request()));

        let denied = read.deny(now).expect("the stale read still denies");
        assert!(!replace(&store, &denied), "the approval won");
        assert_eq!(stored(&store, "dev-1").as_ref(), Some(approved.request()));
    }

    /// The limited page's Continue and Cancel both start from (pending,
    /// unacknowledged): the first to land moves the phase, and the other
    /// doesn't land.
    #[test]
    fn a_cancel_racing_a_continue_on_the_limited_page_does_not_land() {
        let store = SqliteGrantStore::open_in_memory().expect("open in-memory store");
        let now = Utc::now();
        let mut code = fixture_code();
        code.session_shortfall_acknowledged = false;
        let read = AuthorizationRequest::new(
            NewAuthorizationRequest {
                id: "req-1".to_owned(),
                client_id: "app".to_owned(),
                requested_scopes: vec!["read".to_owned()],
                ttl: Duration::minutes(5),
                kind: RequestKind::AuthorizationCode(code),
            },
            now,
        );
        insert(&store, &read);
        let continued = read
            .acknowledge_session_shortfall(Duration::minutes(5), now)
            .expect("continues");
        let cancelled = read.deny_on_limited_page(now).expect("cancels");
        assert!(replace(&store, &continued));
        assert!(!replace(&store, &cancelled));
        assert_eq!(
            stored(&store, "req-1").map(|request| request.status()),
            Some(RequestStatus::Pending)
        );
    }

    /// A poll stamp leaves the phase as it was, so an approval read before it
    /// still lands; a stamp read before an approval no longer does.
    #[test]
    fn approvals_never_fight_poll_stamps() {
        let store = SqliteGrantStore::open_in_memory().expect("open in-memory store");
        let now = Utc::now();
        let read = device_request("dev-1");
        insert(&store, &read);
        let approval = Approval {
            granted_scopes: vec!["openid".to_owned()],
            patient: None,
        };
        assert!(replace(
            &store,
            &read.stamp_device_poll(now).expect("stamps")
        ));
        assert!(replace(
            &store,
            &read.approve_device(approval, None, now).expect("approves")
        ));
        assert!(!replace(
            &store,
            &read.stamp_device_poll(now).expect("stamps")
        ));
        assert_eq!(
            stored(&store, "dev-1").map(|request| request.status()),
            Some(RequestStatus::Approved)
        );
    }

    /// A transition on a row that isn't there lands nowhere.
    #[test]
    fn a_transition_on_a_missing_row_does_not_land() {
        let store = SqliteGrantStore::open_in_memory().expect("open in-memory store");
        let ghost = device_request("ghost");
        assert!(!replace(&store, &ghost.deny(Utc::now()).expect("denies")));
        assert!(stored(&store, "ghost").is_none());
    }

    /// A row missing a field its kind requires, or whose approval disagrees
    /// with its status, fails the read as malformed rather than reading as
    /// absent.
    #[test]
    fn a_malformed_row_fails_the_read() {
        for tamper in [
            "UPDATE authorization_requests SET redirect_uri = NULL WHERE id = 'req-1'",
            "UPDATE authorization_requests SET sid = NULL WHERE id = 'req-1'",
            "UPDATE authorization_requests SET grant_type = 'device_code' WHERE id = 'req-1'",
            "UPDATE authorization_requests SET grant_type = 'browser_pairing', \
             user_code = 'UC' WHERE id = 'req-1'",
            "UPDATE authorization_requests SET status = 'approved' WHERE id = 'req-1'",
            "UPDATE authorization_requests SET granted_scopes = '[]' WHERE id = 'req-1'",
        ] {
            let store = SqliteGrantStore::open_in_memory().expect("open in-memory store");
            insert(&store, &code_request("req-1"));
            execute(&store, tamper);
            assert!(
                store
                    .read(|tx| tx.authorization_request_by_id("req-1"))
                    .is_err(),
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
            insert(&store, &device_request("dev-1"));
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

    fn newest(store: &SqliteGrantStore) -> Option<NewestPendingConsent> {
        store
            .read(|tx| tx.newest_pending_consent(Utc::now()))
            .expect("query")
    }

    /// The newest pending request across every kind is the one the host is
    /// told of, its client named by its `client_id` until it is registered.
    #[test]
    fn newest_pending_consent_picks_the_newest_request_across_every_kind() {
        let store = SqliteGrantStore::open_in_memory().expect("open in-memory store");
        let now = Utc::now();
        insert(
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
            Some(NewestPendingConsent::Device {
                user_code: "UC-1".to_owned(),
                client_name: "device-client".to_owned(),
            })
        );
        insert(&store, &code_request("req-1"));
        assert_eq!(
            newest(&store),
            Some(NewestPendingConsent::OAuth {
                id: "req-1".to_owned(),
                client_name: "app".to_owned(),
                decidable_in_requesting_browser: false,
            })
        );
        let pairing = AuthorizationRequest::new(
            NewAuthorizationRequest {
                id: "pair-1".to_owned(),
                client_id: crate::BROWSER_SESSION_CLIENT_ID.to_owned(),
                requested_scopes: crate::owner_scopes(),
                ttl: Duration::minutes(5),
                kind: RequestKind::BrowserPairing(PairingRequest {
                    user_code: "UC-2".to_owned(),
                    browser_name: "Firefox on Linux".to_owned(),
                    last_polled_at: None,
                }),
            },
            now + Duration::seconds(1),
        );
        insert(&store, &pairing);
        assert_eq!(
            newest(&store),
            Some(NewestPendingConsent::BrowserPairing {
                user_code: "UC-2".to_owned(),
                browser_name: "Firefox on Linux".to_owned(),
            })
        );
    }

    /// Expired, decided and still-unacknowledged requests are no candidates.
    #[test]
    fn newest_pending_consent_skips_what_no_longer_waits_for_the_owner() {
        let store = SqliteGrantStore::open_in_memory().expect("open in-memory store");
        let ten_minutes_ago = Utc::now() - Duration::minutes(10);
        insert(
            &store,
            &device_request_at("expired", "UC-1", ten_minutes_ago, Duration::minutes(5)),
        );
        insert(
            &store,
            &with_status(device_request("approved"), RequestStatus::Approved),
        );
        insert(
            &store,
            &with_status(code_request("denied"), RequestStatus::Denied),
        );
        let mut code = fixture_code();
        code.session_shortfall_acknowledged = false;
        insert(
            &store,
            &AuthorizationRequest::new(
                NewAuthorizationRequest {
                    id: "unacknowledged".to_owned(),
                    client_id: "app".to_owned(),
                    requested_scopes: vec!["read".to_owned()],
                    ttl: Duration::minutes(5),
                    kind: RequestKind::AuthorizationCode(code),
                },
                Utc::now(),
            ),
        );
        assert_eq!(newest(&store), None);
    }

    /// A disabled client's request is no candidate; a client with no row
    /// stays one.
    #[test]
    fn newest_pending_consent_skips_a_disabled_client() {
        let store = SqliteGrantStore::open_in_memory().expect("open in-memory store");
        let now = Utc::now();
        insert(
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
        insert(&store, &code_request("req-1"));
        assert_eq!(
            newest(&store),
            Some(NewestPendingConsent::Device {
                user_code: "UC-1".to_owned(),
                client_name: "device-client".to_owned(),
            })
        );
    }

    /// A registered client is named by its registered name.
    #[test]
    fn newest_pending_consent_names_a_registered_client_by_its_name() {
        let store = SqliteGrantStore::open_in_memory().expect("open in-memory store");
        store
            .write(|tx| {
                tx.upsert_client(&Client {
                    client_id: "app".to_owned(),
                    ..client("app", &["read"])
                })
            })
            .expect("register");
        insert(&store, &code_request("req-1"));
        assert_eq!(
            newest(&store),
            Some(NewestPendingConsent::OAuth {
                id: "req-1".to_owned(),
                client_name: "app display name".to_owned(),
                decidable_in_requesting_browser: false,
            })
        );
    }
}
