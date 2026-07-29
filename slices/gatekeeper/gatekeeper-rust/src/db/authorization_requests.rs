//! `authorization_requests` queries — the in-flight OAuth authorizations for
//! both flows, loaded/stored as [`AuthorizationRequest`].
//!
//! The domain struct is not diesel-mapped directly: its `Option<Url>` and
//! `Option<Vec<String>>` fields would need `From` impls between two foreign
//! `Option` types, which coherence forbids — so a private [`Row`] mirrors the
//! table with the wrapper types ([`UrlText`], [`JsonStrings`]) as field types
//! and converts at the query boundary.

use chrono::{DateTime, Utc};
use diesel::prelude::*;
use diesel::sqlite::SqliteConnection;

use crate::db::shared::{text_enum_column, JsonStrings, UrlText};
use crate::domain::authorization_request::{AuthorizationRequest, GrantType, RequestStatus};
use crate::domain::gatekeeper_error::GatekeeperError;

diesel::table! {
    authorization_requests (id) {
        id -> Text,
        grant_type -> Text,
        client_id -> Text,
        requested_scopes -> Text,
        code_challenge -> Nullable<Text>,
        code_challenge_method -> Nullable<Text>,
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
    }
}

// The request `status` discriminant, stored as its strum wire string. Only the
// authorization request binds it, so its mapping lives here.
text_enum_column!(RequestStatus);

/// The diesel-facing mirror of [`AuthorizationRequest`] — same columns, with
/// the JSON/URL fields as their wrapper types so the nullable ones map
/// without orphan-rule violations.
#[derive(Queryable, Selectable, Insertable)]
#[diesel(table_name = authorization_requests)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
struct Row {
    id: String,
    grant_type: GrantType,
    client_id: String,
    requested_scopes: JsonStrings,
    code_challenge: Option<String>,
    code_challenge_method: Option<String>,
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
}

impl From<Row> for AuthorizationRequest {
    fn from(row: Row) -> Self {
        AuthorizationRequest {
            id: row.id,
            grant_type: row.grant_type,
            client_id: row.client_id,
            requested_scopes: row.requested_scopes.0,
            code_challenge: row.code_challenge,
            code_challenge_method: row.code_challenge_method,
            redirect_uri: row.redirect_uri.map(|u| u.0),
            client_state: row.client_state,
            user_code: row.user_code,
            pre_approved_scopes: row.pre_approved_scopes.0,
            requested_at: row.requested_at,
            expires_at: row.expires_at,
            last_polled_at: row.last_polled_at,
            status: row.status,
            granted_scopes: row.granted_scopes.map(|s| s.0),
            patient: row.patient,
            device_name: row.device_name,
        }
    }
}

impl From<&AuthorizationRequest> for Row {
    fn from(request: &AuthorizationRequest) -> Self {
        Row {
            id: request.id.clone(),
            grant_type: request.grant_type,
            client_id: request.client_id.clone(),
            requested_scopes: JsonStrings(request.requested_scopes.clone()),
            code_challenge: request.code_challenge.clone(),
            code_challenge_method: request.code_challenge_method.clone(),
            redirect_uri: request.redirect_uri.clone().map(UrlText),
            client_state: request.client_state.clone(),
            user_code: request.user_code.clone(),
            pre_approved_scopes: JsonStrings(request.pre_approved_scopes.clone()),
            requested_at: request.requested_at,
            expires_at: request.expires_at,
            last_polled_at: request.last_polled_at,
            status: request.status,
            granted_scopes: request.granted_scopes.clone().map(JsonStrings),
            patient: request.patient.clone(),
            device_name: request.device_name.clone(),
        }
    }
}

/// Load an authorization request by its primary id (the `device_code` for
/// device-flow, otherwise an internal UUID), or `None` when absent.
pub(super) fn authorization_request_by_id(
    conn: &mut SqliteConnection,
    id: &str,
) -> Result<Option<AuthorizationRequest>, GatekeeperError> {
    authorization_requests::table
        .find(id)
        .select(Row::as_select())
        .first(conn)
        .optional()
        .map_err(|e| GatekeeperError::infrastructure("authorization_request_by_id failed", e))
        .map(|row| row.map(AuthorizationRequest::from))
}

/// Load an authorization request by the human-typed `user_code` that the
/// device-flow handed to the user.
///
/// Returns *any* row with the code regardless of status — callers that need
/// to act on a live request (e.g. the consent UI) must use
/// [`pending_authorization_request_by_user_code`] instead, since `user_code` is
/// not unique across terminal rows and a stale denied/expired row could
/// otherwise shadow a fresh pending one.
pub(super) fn authorization_request_by_user_code(
    conn: &mut SqliteConnection,
    user_code: &str,
) -> Result<Option<AuthorizationRequest>, GatekeeperError> {
    authorization_requests::table
        .filter(authorization_requests::user_code.eq(user_code))
        .select(Row::as_select())
        .first(conn)
        .optional()
        .map_err(|e| {
            GatekeeperError::infrastructure("authorization_request_by_user_code failed", e)
        })
        .map(|row| row.map(AuthorizationRequest::from))
}

/// Load the *pending* authorization request for `user_code`. Filtering on
/// `status = 'pending'` ensures a stale denied/expired row sharing the same
/// `user_code` can't shadow a live request and 404 the consent flow.
pub(super) fn pending_authorization_request_by_user_code(
    conn: &mut SqliteConnection,
    user_code: &str,
) -> Result<Option<AuthorizationRequest>, GatekeeperError> {
    authorization_requests::table
        .filter(authorization_requests::user_code.eq(user_code))
        .filter(authorization_requests::status.eq(RequestStatus::Pending))
        .select(Row::as_select())
        .first(conn)
        .optional()
        .map_err(|e| {
            GatekeeperError::infrastructure("pending_authorization_request_by_user_code failed", e)
        })
        .map(|row| row.map(AuthorizationRequest::from))
}

/// Return the `user_code` of the oldest pending, non-expired device-code
/// authorization request — the head the host UI surfaces in its
/// non-dismissable consent modal. Returns `None` if no such request
/// exists.
///
/// The host calls this after every transition that may change the head
/// (a fresh `/oauth/device_authorization` insert; `approve`/`deny` of a
/// device consent) and pushes the result through a `watch::Sender` to
/// the webview bridge. The query is intentionally minimal: only the
/// `user_code` rides the bridge — the SPA reuses the existing
/// `GET /access/devices/{userCode}` fetch path to hydrate the form,
/// so this slice doesn't grow a second DTO for the same row.
///
/// The `user_code IS NOT NULL` guard exists because a malformed half-row
/// could otherwise float to the head with `user_code = NULL` and crash
/// the SPA's `string` decoder.
pub(super) fn oldest_pending_device_user_code(
    conn: &mut SqliteConnection,
) -> Result<Option<String>, GatekeeperError> {
    authorization_requests::table
        .filter(authorization_requests::grant_type.eq(GrantType::DeviceCode))
        .filter(authorization_requests::status.eq(RequestStatus::Pending))
        .filter(authorization_requests::user_code.is_not_null())
        .filter(authorization_requests::expires_at.gt(Utc::now()))
        .order(authorization_requests::requested_at.asc())
        .select(authorization_requests::user_code)
        .first::<Option<String>>(conn)
        .optional()
        .map_err(|e| GatekeeperError::infrastructure("oldest_pending_device_user_code failed", e))
        .map(Option::flatten)
}

/// Persist a freshly-constructed `AuthorizationRequest`.
pub(super) fn insert_authorization_request(
    conn: &mut SqliteConnection,
    request: &AuthorizationRequest,
) -> Result<(), GatekeeperError> {
    let as_infrastructure_error =
        |e| GatekeeperError::infrastructure("insert_authorization_request failed", e);
    // Bulk reclamation belongs to `domain::retention::purge_expired`; what stays
    // here is the narrow half a daily sweep can't cover — an already-expired row
    // holding *this* request's `user_code` at `status = 'pending'` occupies the
    // partial unique index and would make the insert below a hard error. Scoped
    // to expired rows, so a live request is never silently dropped. See
    // `slices/gatekeeper/docs/Retention Explanation.md`.
    if let Some(user_code) = request.user_code.as_deref() {
        diesel::delete(
            authorization_requests::table
                .filter(authorization_requests::user_code.eq(user_code))
                .filter(authorization_requests::expires_at.lt(Utc::now())),
        )
        .execute(conn)
        .map_err(as_infrastructure_error)?;
    }
    diesel::insert_into(authorization_requests::table)
        .values(Row::from(request))
        .execute(conn)
        .map_err(as_infrastructure_error)?;
    Ok(())
}

/// Mark a *pending* `id` approved with `granted_scopes`, an optional patient
/// context, and the request's resolved `device_name`, returning `true` iff a
/// pending row was actually transitioned.
///
/// The `status = 'pending'` guard means a request already in a terminal
/// state (denied/expired) can't be flipped back to approved, and the
/// affected-row check lets the caller detect a no-op (e.g. the request was
/// consumed concurrently between its read and this update).
///
/// `device_name` is written **verbatim** — the "keep the device's own name when
/// the approver didn't adjust it" resolution is the consent action's job (it
/// already holds the loaded request), so the store no longer branches on
/// present-vs-absent. The code-flow path passes `None` (its column is and stays
/// NULL); the device path passes the effective name it resolved.
pub(super) fn approve_authorization_request(
    conn: &mut SqliteConnection,
    id: &str,
    granted_scopes: &[String],
    patient: Option<&str>,
    device_name: Option<&str>,
) -> Result<bool, GatekeeperError> {
    let affected = diesel::update(
        authorization_requests::table
            .find(id)
            .filter(authorization_requests::status.eq(RequestStatus::Pending)),
    )
    .set((
        authorization_requests::status.eq(RequestStatus::Approved),
        authorization_requests::granted_scopes.eq(JsonStrings(granted_scopes.to_vec())),
        authorization_requests::patient.eq(patient),
        authorization_requests::device_name.eq(device_name),
    ))
    .execute(conn)
    .map_err(|e| GatekeeperError::infrastructure("approve_authorization_request failed", e))?;
    Ok(affected == 1)
}

/// Mark `id` denied.
pub(super) fn deny_authorization_request(
    conn: &mut SqliteConnection,
    id: &str,
) -> Result<(), GatekeeperError> {
    diesel::update(authorization_requests::table.find(id))
        .set(authorization_requests::status.eq(RequestStatus::Denied))
        .execute(conn)
        .map_err(|e| GatekeeperError::infrastructure("deny_authorization_request failed", e))?;
    Ok(())
}

/// Atomically claim an `approved` request for single-use redemption,
/// transitioning `approved` → `expired` only if it is still `approved`, and
/// return `true` iff this call won the race.
///
/// The `status = 'approved'` guard plus the affected-row check are what make
/// device-flow redemption single-use (RFC 8628 §3.4) even under concurrent
/// polls: `SQLite`'s write lock serialises the two `UPDATE`s, so exactly one
/// sees a row to change (`true`) and any racer sees zero rows (`false`) and
/// must be rejected before a token is minted.
pub(super) fn consume_approved_authorization_request(
    conn: &mut SqliteConnection,
    id: &str,
) -> Result<bool, GatekeeperError> {
    let affected = diesel::update(
        authorization_requests::table
            .find(id)
            .filter(authorization_requests::status.eq(RequestStatus::Approved)),
    )
    .set(authorization_requests::status.eq(RequestStatus::Expired))
    .execute(conn)
    .map_err(|e| {
        GatekeeperError::infrastructure("consume_approved_authorization_request failed", e)
    })?;
    Ok(affected == 1)
}

/// Stamp `last_polled_at` so the next device-flow poll can be slow-down
/// rate-limited.
pub(super) fn record_device_poll(
    conn: &mut SqliteConnection,
    id: &str,
    polled_at: DateTime<Utc>,
) -> Result<(), GatekeeperError> {
    diesel::update(authorization_requests::table.find(id))
        .set(authorization_requests::last_polled_at.eq(polled_at))
        .execute(conn)
        .map_err(|e| GatekeeperError::infrastructure("record_device_poll failed", e))?;
    Ok(())
}

/// Delete every authorization request that expired before `cutoff`, returning
/// how many rows went. Nothing transitions an abandoned request out of
/// `pending`, so this is the only thing that reclaims one.
///
/// `cutoff` is the *retention* cutoff, not `now`; the window is the caller's
/// (`domain::retention::purge_expired`).
pub(super) fn delete_authorization_requests_expired_before(
    conn: &mut SqliteConnection,
    cutoff: DateTime<Utc>,
) -> Result<usize, GatekeeperError> {
    diesel::delete(
        authorization_requests::table.filter(authorization_requests::expires_at.lt(cutoff)),
    )
    .execute(conn)
    .map_err(|e| {
        GatekeeperError::infrastructure("delete_authorization_requests_expired_before failed", e)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::{arb_opt_timestamp, arb_timestamp, arb_url};
    use crate::db::SqliteGatekeeperStore;
    use crate::domain::{GatekeeperStore as _, GatekeeperTx as _};
    use proptest::prelude::*;

    fn arb_scopes() -> impl Strategy<Value = Vec<String>> {
        prop::collection::vec("[a-z][a-z0-9_]{0,15}", 0..5)
    }

    fn arb_status() -> impl Strategy<Value = RequestStatus> {
        prop_oneof![
            Just(RequestStatus::Pending),
            Just(RequestStatus::Approved),
            Just(RequestStatus::Denied),
            Just(RequestStatus::Expired),
        ]
    }

    // Each nullable field is generated independently so every property run
    // mixes present and absent values regardless of `grant_type`, covering the
    // "optional fields both present and absent" case.
    prop_compose! {
        fn arb_authorization_request()(
            id in "[a-zA-Z0-9_-]{1,40}",
            grant_type in prop_oneof![
                Just(GrantType::AuthorizationCode),
                Just(GrantType::DeviceCode),
            ],
            client_id in "[a-zA-Z0-9_-]{1,32}",
            requested_scopes in arb_scopes(),
            code_challenge in prop::option::of("[A-Za-z0-9_-]{43}"),
            code_challenge_method in prop::option::of(Just("S256".to_string())),
            redirect_uri in prop::option::of(arb_url()),
            client_state in prop::option::of("[A-Za-z0-9_-]{1,32}"),
            user_code in prop::option::of("[A-Z0-9-]{1,16}"),
            pre_approved_scopes in arb_scopes(),
            requested_at in arb_timestamp(),
            expires_at in arb_timestamp(),
            last_polled_at in arb_opt_timestamp(),
            status in arb_status(),
            granted_scopes in prop::option::of(arb_scopes()),
            patient in prop::option::of("[a-zA-Z0-9-]{1,32}"),
            device_name in prop::option::of("[ -~]{1,40}"),
        ) -> AuthorizationRequest {
            AuthorizationRequest {
                id,
                grant_type,
                client_id,
                requested_scopes,
                code_challenge,
                code_challenge_method,
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
            }
        }
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(64))]

        #[test]
        fn insert_and_fetch_round_trip(request in arb_authorization_request()) {
            let store = SqliteGatekeeperStore::open_in_memory().expect("open in-memory store");
            store
                .insert_authorization_request(&request)
                .expect("insert");
            let fetched = store
                .authorization_request_by_id(&request.id)
                .expect("query")
                .expect("row present");
            prop_assert_eq!(fetched, request);
        }
    }

    fn device_request_with_status(id: &str, status: RequestStatus) -> AuthorizationRequest {
        let now = Utc::now();
        AuthorizationRequest {
            id: id.to_string(),
            grant_type: GrantType::DeviceCode,
            client_id: "device-client".to_string(),
            requested_scopes: vec!["openid".to_string()],
            code_challenge: None,
            code_challenge_method: None,
            redirect_uri: None,
            client_state: None,
            // Distinct per id so two pending rows don't collide on the
            // pending-user_code partial unique index in multi-row tests.
            user_code: Some(format!("UC-{id}")),
            pre_approved_scopes: vec![],
            requested_at: now,
            expires_at: now + chrono::Duration::minutes(5),
            last_polled_at: None,
            status,
            granted_scopes: Some(vec!["openid".to_string()]),
            patient: None,
            device_name: None,
        }
    }

    // Bulk reclamation moved to the retention sweep (#164), so an unrelated
    // insert no longer destroys the audit trail: an expired row survives until
    // it ages past the 7-day window. Previously *every* expired row went on the
    // next insert, which made a retention window unenforceable.
    #[test]
    fn insert_leaves_unrelated_expired_requests_for_the_sweep() {
        let store = SqliteGatekeeperStore::open_in_memory().expect("open in-memory store");
        let mut expired = device_request_with_status("expired-1", RequestStatus::Pending);
        expired.expires_at = Utc::now() - chrono::Duration::minutes(1);
        store
            .insert_authorization_request(&expired)
            .expect("insert expired");

        store
            .insert_authorization_request(&device_request_with_status(
                "fresh-1",
                RequestStatus::Pending,
            ))
            .expect("insert fresh");

        assert!(
            store
                .authorization_request_by_id("expired-1")
                .expect("query")
                .is_some(),
            "an unrelated expired row is the sweep's to reclaim, not this insert's",
        );
        assert!(store
            .authorization_request_by_id("fresh-1")
            .expect("query")
            .is_some());
    }

    // The one thing the insert still prunes: an expired row holding the same
    // `user_code` at `status = 'pending'`. Nothing transitions an abandoned
    // request out of `pending`, so such a row sits in the partial
    // pending-user_code unique index and would make this insert a hard error —
    // and it may be up to a sweep interval away from being reclaimed.
    #[test]
    fn insert_clears_an_expired_row_holding_the_same_user_code() {
        let store = SqliteGatekeeperStore::open_in_memory().expect("open in-memory store");
        let mut expired = device_request("dev-stale", "SAME-CODE", RequestStatus::Pending);
        expired.expires_at = Utc::now() - chrono::Duration::minutes(1);
        store
            .insert_authorization_request(&expired)
            .expect("insert expired");

        let colliding = device_request("dev-new", "SAME-CODE", RequestStatus::Pending);
        store
            .insert_authorization_request(&colliding)
            .expect("the colliding insert must not hit the unique index");

        assert!(store
            .authorization_request_by_id("dev-stale")
            .expect("query")
            .is_none());
        assert!(store
            .authorization_request_by_id("dev-new")
            .expect("query")
            .is_some());
    }

    // ...but only *expired* rows: a live pending request holding the code is
    // never silently dropped to make room. A genuine collision on a live code
    // stays a hard error, exactly as before.
    #[test]
    fn insert_never_drops_a_live_row_holding_the_same_user_code() {
        let store = SqliteGatekeeperStore::open_in_memory().expect("open in-memory store");
        let live = device_request("dev-live", "SAME-CODE", RequestStatus::Pending);
        store
            .insert_authorization_request(&live)
            .expect("insert live");

        let colliding = device_request("dev-new", "SAME-CODE", RequestStatus::Pending);
        assert!(
            store.insert_authorization_request(&colliding).is_err(),
            "colliding with a live pending user_code must stay a hard error",
        );
        assert!(store
            .authorization_request_by_id("dev-live")
            .expect("query")
            .is_some());
    }

    // The retention delete is a strict `<` on the cutoff the policy hands down:
    // rows past it go, rows inside it and live rows stay.
    #[test]
    fn delete_expired_requests_respects_the_cutoff() {
        let store = SqliteGatekeeperStore::open_in_memory().expect("open in-memory store");
        let mut old = device_request("dev-old", "OLD-0000", RequestStatus::Pending);
        old.expires_at = Utc::now() - chrono::Duration::days(8);
        store
            .insert_authorization_request(&old)
            .expect("insert old");
        let mut recent = device_request("dev-recent", "REC-0000", RequestStatus::Pending);
        recent.expires_at = Utc::now() - chrono::Duration::days(6);
        store
            .insert_authorization_request(&recent)
            .expect("insert recent");
        store
            .insert_authorization_request(&device_request(
                "dev-live",
                "LIV-0000",
                RequestStatus::Pending,
            ))
            .expect("insert live");

        let purged = store
            .with_connection(|tx| {
                tx.delete_authorization_requests_expired_before(
                    Utc::now() - chrono::Duration::days(7),
                )
            })
            .expect("delete");

        assert_eq!(purged, 1);
        assert!(store
            .authorization_request_by_id("dev-old")
            .expect("query")
            .is_none());
        assert!(store
            .authorization_request_by_id("dev-recent")
            .expect("query")
            .is_some());
        assert!(store
            .authorization_request_by_id("dev-live")
            .expect("query")
            .is_some());
    }

    // Single-use enforcement for the device-code grant (RFC 8628 §3.4): the
    // first claim of an approved request wins and transitions it out of
    // `approved`; a second (the racing/duplicate poll) loses. This is the
    // atomicity that stops two concurrent polls both minting tokens.
    #[test]
    fn consume_approved_authorization_request_is_single_use() {
        let store = SqliteGatekeeperStore::open_in_memory().expect("open in-memory store");
        store
            .insert_authorization_request(&device_request_with_status(
                "dev-1",
                RequestStatus::Approved,
            ))
            .expect("insert");

        assert!(store
            .consume_approved_authorization_request("dev-1")
            .expect("first claim query"));
        assert!(!store
            .consume_approved_authorization_request("dev-1")
            .expect("second claim query"));

        let after = store
            .authorization_request_by_id("dev-1")
            .expect("query")
            .expect("row present");
        assert_eq!(after.status, RequestStatus::Expired);
    }

    fn device_request(id: &str, user_code: &str, status: RequestStatus) -> AuthorizationRequest {
        let now = Utc::now();
        AuthorizationRequest {
            id: id.to_string(),
            grant_type: GrantType::DeviceCode,
            client_id: "device-client".to_string(),
            requested_scopes: vec!["openid".to_string()],
            code_challenge: None,
            code_challenge_method: None,
            redirect_uri: None,
            client_state: None,
            user_code: Some(user_code.to_string()),
            pre_approved_scopes: vec![],
            requested_at: now,
            expires_at: now + chrono::Duration::minutes(5),
            last_polled_at: None,
            status,
            granted_scopes: None,
            patient: None,
            device_name: None,
        }
    }

    // FIFO head selector: oldest pending non-expired device-code row wins.
    // A code-flow row, a non-pending row, and an expired row are all
    // ignored — proves each filter pulls its weight.
    #[test]
    fn oldest_pending_device_user_code_picks_the_fifo_head() {
        let store = SqliteGatekeeperStore::open_in_memory().expect("open in-memory store");

        // Empty → None.
        assert_eq!(
            store
                .oldest_pending_device_user_code()
                .expect("query empty"),
            None
        );

        // Insert two pending device rows with explicit requested_at ordering;
        // proptest's arbitrary timestamps would let one shadow the other
        // without the FIFO discriminator being visible.
        let now = Utc::now();
        let mut older = device_request("dev-older", "AAA-111", RequestStatus::Pending);
        older.requested_at = now - chrono::Duration::seconds(30);
        let mut newer = device_request("dev-newer", "BBB-222", RequestStatus::Pending);
        newer.requested_at = now;
        store
            .insert_authorization_request(&older)
            .expect("insert older");
        store
            .insert_authorization_request(&newer)
            .expect("insert newer");

        assert_eq!(
            store
                .oldest_pending_device_user_code()
                .expect("query")
                .as_deref(),
            Some("AAA-111")
        );

        // A code-flow row with an even older requested_at must not become the
        // head — the query is device-only.
        let code_row = AuthorizationRequest {
            id: "code-1".to_string(),
            grant_type: GrantType::AuthorizationCode,
            user_code: None,
            requested_at: now - chrono::Duration::seconds(120),
            ..device_request("code-1", "unused", RequestStatus::Pending)
        };
        store
            .insert_authorization_request(&code_row)
            .expect("insert code row");
        assert_eq!(
            store
                .oldest_pending_device_user_code()
                .expect("query")
                .as_deref(),
            Some("AAA-111")
        );

        // Denying the head promotes the next pending row.
        store
            .deny_authorization_request("dev-older")
            .expect("deny older");
        assert_eq!(
            store
                .oldest_pending_device_user_code()
                .expect("query")
                .as_deref(),
            Some("BBB-222")
        );

        // Denying the last pending row leaves no head.
        store
            .deny_authorization_request("dev-newer")
            .expect("deny newer");
        assert_eq!(
            store
                .oldest_pending_device_user_code()
                .expect("query final"),
            None
        );
    }

    // Expired pending rows are filtered out: the FIFO head must skip a row
    // whose `expires_at` is in the past. The regular insert prunes via
    // `expires_at < now`, but a row inserted *first* sits in the table
    // until the next insert sweeps it — the popup query must not pick it
    // up in that window either.
    #[test]
    fn oldest_pending_device_user_code_skips_expired_rows() {
        let store = SqliteGatekeeperStore::open_in_memory().expect("open in-memory store");
        let mut expired = device_request("dev-expired", "EXP-000", RequestStatus::Pending);
        expired.expires_at = Utc::now() - chrono::Duration::minutes(1);
        store
            .insert_authorization_request(&expired)
            .expect("insert expired");
        // Row is in the table (no other insert has swept it).
        assert!(store
            .authorization_request_by_id("dev-expired")
            .expect("query")
            .is_some());
        // Popup-head query filters it out.
        assert_eq!(
            store.oldest_pending_device_user_code().expect("query"),
            None
        );
    }

    // A request that is not `approved` is never claimable and is left untouched
    // — the guard transitions only `approved` → `expired`.
    #[test]
    fn consume_approved_authorization_request_ignores_non_approved() {
        let store = SqliteGatekeeperStore::open_in_memory().expect("open in-memory store");
        store
            .insert_authorization_request(&device_request_with_status(
                "dev-2",
                RequestStatus::Pending,
            ))
            .expect("insert");

        assert!(!store
            .consume_approved_authorization_request("dev-2")
            .expect("pending is not claimable"));

        let after = store
            .authorization_request_by_id("dev-2")
            .expect("query")
            .expect("row present");
        assert_eq!(after.status, RequestStatus::Pending);
    }

    /// The [`RequestStatus`] and [`GrantType`] text-enum mappings reject an unknown
    /// stored discriminant on read as a typed error, never a panic — a tampered
    /// `status`/`grant_type` can't decode to a wrong-but-valid enum member.
    #[test]
    fn corrupt_enum_columns_are_typed_read_errors() {
        for column in ["status", "grant_type"] {
            let store = SqliteGatekeeperStore::open_in_memory().expect("open in-memory store");
            store
                .insert_authorization_request(&device_request_with_status(
                    "dev-1",
                    RequestStatus::Pending,
                ))
                .expect("insert");
            let mut conn = store.pool().get().expect("check out a connection");
            diesel::sql_query(format!(
                "UPDATE authorization_requests SET {column} = 'bogus' WHERE id = 'dev-1'"
            ))
            .execute(&mut conn)
            .expect("tamper the stored row");
            drop(conn);
            assert!(
                store.authorization_request_by_id("dev-1").is_err(),
                "a corrupt `{column}` must surface as a typed read error",
            );
        }
    }
}
