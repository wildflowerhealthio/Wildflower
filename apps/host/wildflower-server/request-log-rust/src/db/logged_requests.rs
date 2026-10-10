//! `logged_requests` queries — the `SQLite` adapter bodies behind
//! `SqliteRequestLogStore`'s [`RequestLogStore`](crate::domain::RequestLogStore)
//! impl. A [`ForwardedRequest`] is flattened into a [`NewLoggedRequestRow`] on
//! the way in, and a [`LoggedRequestRow`] is folded back into a
//! [`LoggedRequest`] on the way out.

use std::time::Duration;

use chrono::{DateTime, Utc};
use diesel::dsl::max;
use diesel::prelude::*;
use diesel::sql_types::{BigInt, Integer, Nullable, Text, TimestamptzSqlite};
use wildflowerhealthio_persistence::PooledDieselConnection;
use wildflowerhealthio_shared_structures::request_caller::{
    ForwardedRequest, RequestCaller, RequestRefusal,
};

use crate::db::schema::logged_requests;
use crate::domain::request_log::{
    CallerSummary, LoggedRequest, RequestAuth, RequestLogFilter, RequestLogPage, REFUSED_STATUSES,
    REQUEST_LOG_PAGE_SIZE,
};
use crate::domain::{CallerClass, RequestLogError};

/// A [`ForwardedRequest`] as one `logged_requests` row, ready to insert.
#[derive(Debug, Insertable)]
#[diesel(table_name = logged_requests)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
struct NewLoggedRequestRow<'a> {
    received_at: DateTime<Utc>,
    client_id: Option<&'a str>,
    address: Option<&'a str>,
    served_host: Option<&'a str>,
    method: &'a str,
    path: &'a str,
    status: i32,
    response_bytes: Option<i64>,
    duration_ms: i64,
    refusal: Option<&'static str>,
}

impl<'a> NewLoggedRequestRow<'a> {
    /// Flatten `request` into its row.
    ///
    /// # Errors
    ///
    /// [`RequestLogError::Infrastructure`] if the response size or duration doesn't
    /// fit the `INTEGER` column.
    fn from_forwarded_request(request: &'a ForwardedRequest) -> Result<Self, RequestLogError> {
        Ok(NewLoggedRequestRow {
            received_at: DateTime::<Utc>::from(request.received_at),
            client_id: request
                .caller
                .as_ref()
                .map(|caller| caller.client_id.as_str()),
            address: request.client_address.as_deref(),
            served_host: request.served_host.as_deref(),
            method: &request.method,
            path: &request.reduced_path,
            status: i32::from(request.status),
            response_bytes: request
                .response_bytes
                .map(i64::try_from)
                .transpose()
                .map_err(|e| RequestLogError::infrastructure("response size out of range", e))?,
            duration_ms: i64::try_from(request.duration.as_millis())
                .map_err(|e| RequestLogError::infrastructure("request duration out of range", e))?,
            refusal: request.refusal.map(refusal_column),
        })
    }
}

/// The `refusal` column's value for `refusal` — one of the values the column's
/// `CHECK` allows.
fn refusal_column(refusal: RequestRefusal) -> &'static str {
    match refusal {
        RequestRefusal::MissingToken => "missing_token",
        RequestRefusal::TokenRejected => "token_rejected",
        RequestRefusal::Revoked => "revoked",
    }
}

/// The [`RequestRefusal`] a `refusal` column value names; the inverse of
/// [`refusal_column`].
///
/// # Errors
///
/// [`RequestLogError::Infrastructure`] for a value the column's `CHECK` forbids.
fn refusal_from_column(column: &str) -> Result<RequestRefusal, RequestLogError> {
    match column {
        "missing_token" => Ok(RequestRefusal::MissingToken),
        "token_rejected" => Ok(RequestRefusal::TokenRejected),
        "revoked" => Ok(RequestRefusal::Revoked),
        unknown => Err(RequestLogError::infrastructure(
            "unknown refusal in the request log",
            unknown,
        )),
    }
}

/// A `logged_requests` status as the `u16` it was written from.
fn status_from_column(status: i32) -> Result<u16, RequestLogError> {
    u16::try_from(status)
        .map_err(|e| RequestLogError::infrastructure("status out of range in the request log", e))
}

/// A `logged_requests` row as diesel loads it, before it's folded into a
/// [`LoggedRequest`].
#[derive(Debug, Queryable, Selectable)]
#[diesel(table_name = logged_requests)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
struct LoggedRequestRow {
    id: i64,
    received_at: DateTime<Utc>,
    client_id: Option<String>,
    address: Option<String>,
    served_host: Option<String>,
    method: String,
    path: String,
    status: i32,
    response_bytes: Option<i64>,
    duration_ms: i64,
    refusal: Option<String>,
}

impl TryFrom<LoggedRequestRow> for LoggedRequest {
    type Error = RequestLogError;

    fn try_from(row: LoggedRequestRow) -> Result<Self, RequestLogError> {
        Ok(LoggedRequest {
            id: row.id,
            request: ForwardedRequest {
                received_at: row.received_at.into(),
                client_address: row.address,
                served_host: row.served_host,
                method: row.method,
                reduced_path: row.path,
                status: status_from_column(row.status)?,
                response_bytes: row
                    .response_bytes
                    .map(u64::try_from)
                    .transpose()
                    .map_err(|e| {
                        RequestLogError::infrastructure(
                            "response size out of range in the request log",
                            e,
                        )
                    })?,
                duration: u64::try_from(row.duration_ms)
                    .map(Duration::from_millis)
                    .map_err(|e| {
                        RequestLogError::infrastructure(
                            "duration out of range in the request log",
                            e,
                        )
                    })?,
                caller: row.client_id.map(|client_id| RequestCaller { client_id }),
                refusal: row
                    .refusal
                    .as_deref()
                    .map(refusal_from_column)
                    .transpose()?,
            },
        })
    }
}

/// One (caller, client address) group as the callers query returns it,
/// before it's folded into a [`CallerSummary`].
#[derive(Debug, QueryableByName)]
struct CallerSummaryRow {
    #[diesel(sql_type = Nullable<Text>)]
    client_id: Option<String>,
    #[diesel(sql_type = Nullable<Text>)]
    address: Option<String>,
    #[diesel(sql_type = TimestamptzSqlite)]
    first_seen: DateTime<Utc>,
    #[diesel(sql_type = TimestamptzSqlite)]
    last_seen: DateTime<Utc>,
    #[diesel(sql_type = BigInt)]
    request_count: i64,
    #[diesel(sql_type = BigInt)]
    refused_count: i64,
    #[diesel(sql_type = Integer)]
    last_status: i32,
    #[diesel(sql_type = Nullable<Text>)]
    last_refusal: Option<String>,
}

impl TryFrom<CallerSummaryRow> for CallerSummary {
    type Error = RequestLogError;

    fn try_from(row: CallerSummaryRow) -> Result<Self, RequestLogError> {
        Ok(CallerSummary {
            caller: row.client_id.map(|client_id| RequestCaller { client_id }),
            client_address: row.address,
            first_seen: row.first_seen,
            last_seen: row.last_seen,
            request_count: row.request_count,
            refused_count: row.refused_count,
            last_status: status_from_column(row.last_status)?,
            last_refusal: row
                .last_refusal
                .as_deref()
                .map(refusal_from_column)
                .transpose()?,
        })
    }
}

/// Insert `requests` in one multi-row `INSERT`. Backs
/// [`SqliteRequestLogStore::insert_requests`](crate::db::SqliteRequestLogStore).
///
/// # Errors
///
/// [`RequestLogError::Infrastructure`] if a row can't be flattened or the insert
/// fails.
pub(super) fn insert_requests(
    conn: &mut PooledDieselConnection,
    requests: &[ForwardedRequest],
) -> Result<(), RequestLogError> {
    let rows = requests
        .iter()
        .map(NewLoggedRequestRow::from_forwarded_request)
        .collect::<Result<Vec<_>, _>>()?;
    diesel::insert_into(logged_requests::table)
        .values(&rows)
        .execute(conn)
        .map_err(|e| RequestLogError::infrastructure("insert logged requests failed", e))?;
    Ok(())
}

/// Delete `caller_class`'s rows at least `row_cap` ids behind its newest one.
/// Reads the class's newest id and deletes below it in one transaction, each
/// through the class's partial index on `id`. Backs
/// [`SqliteRequestLogStore::delete_requests_beyond_cap`](crate::db::SqliteRequestLogStore).
///
/// # Errors
///
/// [`RequestLogError::Infrastructure`] on a read / delete failure.
pub(super) fn delete_requests_beyond_cap(
    conn: &mut PooledDieselConnection,
    caller_class: CallerClass,
    row_cap: i64,
) -> Result<usize, RequestLogError> {
    conn.transaction::<_, diesel::result::Error, _>(|conn| match caller_class {
        CallerClass::Verified => {
            let in_class = logged_requests::client_id.is_not_null();
            let newest_id: Option<i64> = logged_requests::table
                .filter(in_class)
                .select(max(logged_requests::id))
                .first(conn)?;
            let Some(newest_id) = newest_id else {
                return Ok(0);
            };
            diesel::delete(
                logged_requests::table
                    .filter(in_class)
                    .filter(logged_requests::id.le(newest_id - row_cap)),
            )
            .execute(conn)
        }
        CallerClass::Unverified => {
            let in_class = logged_requests::client_id.is_null();
            let newest_id: Option<i64> = logged_requests::table
                .filter(in_class)
                .select(max(logged_requests::id))
                .first(conn)?;
            let Some(newest_id) = newest_id else {
                return Ok(0);
            };
            diesel::delete(
                logged_requests::table
                    .filter(in_class)
                    .filter(logged_requests::id.le(newest_id - row_cap)),
            )
            .execute(conn)
        }
    })
    .map_err(|e| RequestLogError::infrastructure("trim logged requests to their cap failed", e))
}

/// The page `filter` selects, newest first, keyset-paged on `id`. Reads one row
/// past the page to learn whether another follows. Backs
/// [`SqliteRequestLogStore::requests_page`](crate::db::SqliteRequestLogStore).
///
/// # Errors
///
/// [`RequestLogError::Infrastructure`] on a read failure, or a row the log could
/// not have written.
pub(super) fn requests_page(
    conn: &mut PooledDieselConnection,
    filter: &RequestLogFilter,
) -> Result<RequestLogPage, RequestLogError> {
    let refused_statuses = REFUSED_STATUSES.map(i32::from);
    let mut query = logged_requests::table
        .select(LoggedRequestRow::as_select())
        .order(logged_requests::id.desc())
        .limit(REQUEST_LOG_PAGE_SIZE + 1)
        .into_boxed();
    if let Some(before_id) = filter.before_id {
        query = query.filter(logged_requests::id.lt(before_id));
    }
    if let Some(client_id) = &filter.client_id {
        query = query.filter(logged_requests::client_id.eq(client_id));
    }
    if let Some(client_address) = &filter.client_address {
        query = query.filter(logged_requests::address.eq(client_address));
    }
    match filter.auth {
        Some(RequestAuth::Authorized) => {
            query = query
                .filter(logged_requests::client_id.is_not_null())
                .filter(logged_requests::status.ne_all(refused_statuses));
        }
        Some(RequestAuth::Public) => {
            query = query
                .filter(logged_requests::client_id.is_null())
                .filter(logged_requests::status.ne_all(refused_statuses));
        }
        Some(RequestAuth::Refused) => {
            query = query.filter(logged_requests::status.eq_any(refused_statuses));
        }
        None => {}
    }
    let mut requests = query
        .load(conn)
        .map_err(|e| RequestLogError::infrastructure("read logged requests failed", e))?
        .into_iter()
        .map(LoggedRequest::try_from)
        .collect::<Result<Vec<_>, _>>()?;
    let page_size = usize::try_from(REQUEST_LOG_PAGE_SIZE).expect("the page size fits a usize");
    let next_cursor = if requests.len() > page_size {
        requests.truncate(page_size);
        requests.last().map(|last| last.id)
    } else {
        None
    };
    Ok(RequestLogPage {
        requests,
        next_cursor,
    })
}

/// The log grouped by (`client_id`, `address`) over their index, each group's
/// newest row joined back for its last outcome, the group with the newest
/// request first. Backs
/// [`SqliteRequestLogStore::caller_summaries`](crate::db::SqliteRequestLogStore).
///
/// # Errors
///
/// [`RequestLogError::Infrastructure`] on a read failure, or a row the log could
/// not have written.
pub(super) fn caller_summaries(
    conn: &mut PooledDieselConnection,
) -> Result<Vec<CallerSummary>, RequestLogError> {
    let [refused_401, refused_403] = REFUSED_STATUSES.map(i32::from);
    diesel::sql_query(
        "WITH callers AS (              SELECT client_id, address,                     MIN(received_at) AS first_seen,                     MAX(received_at) AS last_seen,                     COUNT(*) AS request_count,                     SUM(status IN (?, ?)) AS refused_count,                     MAX(id) AS last_id              FROM logged_requests              GROUP BY client_id, address          )          SELECT callers.client_id, callers.address, callers.first_seen,                 callers.last_seen, callers.request_count, callers.refused_count,                 last.status AS last_status, last.refusal AS last_refusal          FROM callers JOIN logged_requests AS last ON last.id = callers.last_id          ORDER BY callers.last_id DESC",
    )
    .bind::<Integer, _>(refused_401)
    .bind::<Integer, _>(refused_403)
    .load::<CallerSummaryRow>(conn)
    .map_err(|e| RequestLogError::infrastructure("read logged request callers failed", e))?
    .into_iter()
    .map(CallerSummary::try_from)
    .collect()
}

/// Delete every row received before `cutoff`, through the `received_at` index.
/// Backs
/// [`SqliteRequestLogStore::delete_requests_received_before`](crate::db::SqliteRequestLogStore).
///
/// # Errors
///
/// [`RequestLogError::Infrastructure`] on a delete failure.
pub(super) fn delete_requests_received_before(
    conn: &mut PooledDieselConnection,
    cutoff: DateTime<Utc>,
) -> Result<usize, RequestLogError> {
    diesel::delete(logged_requests::table.filter(logged_requests::received_at.lt(cutoff)))
        .execute(conn)
        .map_err(|e| RequestLogError::infrastructure("delete expired logged requests failed", e))
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::time::{Duration, SystemTime};

    use diesel::prelude::*;
    use wildflowerhealthio_shared_structures::request_caller::{ForwardedRequest, RequestCaller};

    use crate::db::schema::logged_requests;
    use crate::db::SqliteRequestLogStore;

    /// Every logged row's `client_id`, oldest first.
    pub(crate) fn logged_client_ids(store: &SqliteRequestLogStore) -> Vec<Option<String>> {
        logged_requests::table
            .select(logged_requests::client_id)
            .order(logged_requests::id)
            .load(&mut store.connection().expect("connection"))
            .expect("rows")
    }

    /// A forwarded request from `client_id` (or no verified caller when `None`)
    /// that arrived `received_at`.
    pub(crate) fn forwarded_request(
        client_id: Option<&str>,
        received_at: SystemTime,
    ) -> ForwardedRequest {
        ForwardedRequest {
            received_at,
            client_address: Some("192.0.2.1".to_owned()),
            served_host: Some("dev1.example.com".to_owned()),
            method: "GET".to_owned(),
            reduced_path: "/fhir-r4/Patient".to_owned(),
            status: if client_id.is_some() { 200 } else { 401 },
            response_bytes: Some(512),
            duration: Duration::from_millis(12),
            caller: client_id.map(|client_id| RequestCaller {
                client_id: client_id.to_owned(),
            }),
            refusal: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::SystemTime;

    use wildflowerhealthio_shared_structures::request_caller::RequestRefusal;

    use super::test_support::forwarded_request;
    use super::*;
    use crate::db::SqliteRequestLogStore;
    use crate::domain::RequestLogStore;

    fn store() -> SqliteRequestLogStore {
        SqliteRequestLogStore::open_in_memory().expect("open in-memory store")
    }

    /// Every row's `(id, client_id)`, oldest first.
    fn rows(store: &SqliteRequestLogStore) -> Vec<(i64, Option<String>)> {
        logged_requests::table
            .select((logged_requests::id, logged_requests::client_id))
            .order(logged_requests::id)
            .load(&mut store.connection().expect("connection"))
            .expect("rows")
    }

    #[test]
    fn a_batch_inserts_one_row_per_request_in_order() {
        let store = store();
        let mut refused = forwarded_request(None, SystemTime::now());
        refused.refusal = Some(RequestRefusal::Revoked);
        store
            .insert_requests(&[
                forwarded_request(Some("lifting"), SystemTime::now()),
                refused,
                forwarded_request(Some("viewer"), SystemTime::now()),
            ])
            .expect("insert");

        assert_eq!(
            rows(&store),
            vec![
                (1, Some("lifting".to_owned())),
                (2, None),
                (3, Some("viewer".to_owned())),
            ]
        );
        let (path, status, duration_ms, refusal): (String, i32, i64, Option<String>) =
            logged_requests::table
                .select((
                    logged_requests::path,
                    logged_requests::status,
                    logged_requests::duration_ms,
                    logged_requests::refusal,
                ))
                .filter(logged_requests::id.eq(2))
                .first(&mut store.connection().expect("connection"))
                .expect("row 2");
        assert_eq!(
            (path.as_str(), status, duration_ms, refusal.as_deref()),
            ("/fhir-r4/Patient", 401, 12, Some("revoked"))
        );
    }

    /// A flood of unverified requests past their cap evicts the oldest
    /// unverified rows and never a verified one, and the verified cap evicts
    /// only verified rows in turn.
    #[test]
    fn each_cap_evicts_only_its_own_class_oldest_first() {
        let store = store();
        let now = SystemTime::now();
        // ids 1–2 verified, 3–7 unverified.
        let mut requests = vec![
            forwarded_request(Some("lifting"), now),
            forwarded_request(Some("lifting"), now),
        ];
        requests.extend((0..5).map(|_| forwarded_request(None, now)));
        store.insert_requests(&requests).expect("insert");

        assert_eq!(
            store
                .delete_requests_beyond_cap(CallerClass::Unverified, 3)
                .expect("trim"),
            2
        );
        assert_eq!(
            rows(&store).iter().map(|(id, _)| *id).collect::<Vec<_>>(),
            vec![1, 2, 5, 6, 7],
            "the two oldest unverified rows went; both verified rows stayed"
        );

        assert_eq!(
            store
                .delete_requests_beyond_cap(CallerClass::Verified, 1)
                .expect("trim"),
            1
        );
        assert_eq!(
            rows(&store).iter().map(|(id, _)| *id).collect::<Vec<_>>(),
            vec![2, 5, 6, 7]
        );
    }

    /// A request from `client_id` at `address` that arrived `seconds` after a
    /// fixed instant, answered `status` (with `refusal`).
    fn request_at(
        client_id: Option<&str>,
        address: &str,
        seconds: i64,
        status: u16,
        refusal: Option<RequestRefusal>,
    ) -> ForwardedRequest {
        let start = DateTime::parse_from_rfc3339("2026-07-01T12:00:00Z")
            .expect("fixed instant")
            .with_timezone(&Utc);
        ForwardedRequest {
            client_address: Some(address.to_owned()),
            status,
            refusal,
            ..forwarded_request(
                client_id,
                (start + chrono::Duration::seconds(seconds)).into(),
            )
        }
    }

    fn at(seconds: i64) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-07-01T12:00:00Z")
            .expect("fixed instant")
            .with_timezone(&Utc)
            + chrono::Duration::seconds(seconds)
    }

    #[test]
    fn a_page_reads_back_what_was_logged_newest_first() {
        let store = store();
        let refused = request_at(
            None,
            "203.0.113.9",
            1,
            401,
            Some(RequestRefusal::MissingToken),
        );
        let served = request_at(Some("lifting"), "192.0.2.1", 2, 200, None);
        store
            .insert_requests(&[refused.clone(), served.clone()])
            .expect("insert");

        let page = store
            .requests_page(&RequestLogFilter::default())
            .expect("page");

        assert_eq!(
            page,
            RequestLogPage {
                requests: vec![
                    LoggedRequest {
                        id: 2,
                        request: served
                    },
                    LoggedRequest {
                        id: 1,
                        request: refused
                    },
                ],
                next_cursor: None,
            }
        );
    }

    /// Pages follow the cursor without gaps or repeats, and the last page has
    /// no cursor.
    #[test]
    fn pages_follow_the_cursor_to_the_oldest_request() {
        let store = store();
        let page_size = usize::try_from(REQUEST_LOG_PAGE_SIZE).expect("fits");
        let requests: Vec<ForwardedRequest> = (0..page_size + 5)
            .map(|_| forwarded_request(Some("lifting"), SystemTime::now()))
            .collect();
        store.insert_requests(&requests).expect("insert");

        let first = store
            .requests_page(&RequestLogFilter::default())
            .expect("first page");
        assert_eq!(first.requests.len(), page_size);
        assert_eq!(first.requests[0].id, 105);
        assert_eq!(first.next_cursor, Some(6));

        let second = store
            .requests_page(&RequestLogFilter {
                before_id: first.next_cursor,
                ..RequestLogFilter::default()
            })
            .expect("second page");
        assert_eq!(
            second
                .requests
                .iter()
                .map(|logged| logged.id)
                .collect::<Vec<_>>(),
            vec![5, 4, 3, 2, 1]
        );
        assert_eq!(second.next_cursor, None);
    }

    #[test]
    fn a_page_honours_every_filter() {
        let store = store();
        store
            .insert_requests(&[
                request_at(Some("lifting"), "192.0.2.1", 1, 200, None),
                request_at(Some("lifting"), "192.0.2.1", 2, 403, None),
                request_at(Some("lifting"), "192.0.2.2", 3, 200, None),
                request_at(
                    None,
                    "192.0.2.1",
                    4,
                    401,
                    Some(RequestRefusal::TokenRejected),
                ),
                request_at(None, "192.0.2.1", 5, 200, None),
            ])
            .expect("insert");
        let ids = |filter: RequestLogFilter| {
            store
                .requests_page(&filter)
                .expect("page")
                .requests
                .iter()
                .map(|logged| logged.id)
                .collect::<Vec<_>>()
        };

        assert_eq!(
            ids(RequestLogFilter {
                client_id: Some("lifting".to_owned()),
                ..RequestLogFilter::default()
            }),
            vec![3, 2, 1]
        );
        assert_eq!(
            ids(RequestLogFilter {
                client_address: Some("192.0.2.1".to_owned()),
                ..RequestLogFilter::default()
            }),
            vec![5, 4, 2, 1]
        );
        assert_eq!(
            ids(RequestLogFilter {
                auth: Some(RequestAuth::Authorized),
                ..RequestLogFilter::default()
            }),
            vec![3, 1]
        );
        assert_eq!(
            ids(RequestLogFilter {
                auth: Some(RequestAuth::Public),
                ..RequestLogFilter::default()
            }),
            vec![5]
        );
        assert_eq!(
            ids(RequestLogFilter {
                auth: Some(RequestAuth::Refused),
                ..RequestLogFilter::default()
            }),
            vec![4, 2]
        );
        assert_eq!(
            ids(RequestLogFilter {
                client_id: Some("lifting".to_owned()),
                client_address: Some("192.0.2.1".to_owned()),
                auth: Some(RequestAuth::Authorized),
                before_id: Some(4),
            }),
            vec![1]
        );
    }

    #[test]
    fn caller_summaries_group_by_caller_and_address_and_counts_refusals() {
        let store = store();
        store
            .insert_requests(&[
                request_at(Some("lifting"), "192.0.2.1", 10, 200, None),
                request_at(
                    None,
                    "203.0.113.9",
                    20,
                    401,
                    Some(RequestRefusal::MissingToken),
                ),
                request_at(Some("lifting"), "192.0.2.1", 30, 403, None),
                request_at(Some("lifting"), "192.0.2.1", 40, 200, None),
                request_at(None, "203.0.113.9", 50, 401, Some(RequestRefusal::Revoked)),
                request_at(Some("lifting"), "192.0.2.2", 5, 200, None),
            ])
            .expect("insert");

        let callers = store.caller_summaries().expect("callers");

        assert_eq!(
            callers,
            vec![
                CallerSummary {
                    caller: Some(RequestCaller {
                        client_id: "lifting".to_owned()
                    }),
                    client_address: Some("192.0.2.2".to_owned()),
                    first_seen: at(5),
                    last_seen: at(5),
                    request_count: 1,
                    refused_count: 0,
                    last_status: 200,
                    last_refusal: None,
                },
                CallerSummary {
                    caller: None,
                    client_address: Some("203.0.113.9".to_owned()),
                    first_seen: at(20),
                    last_seen: at(50),
                    request_count: 2,
                    refused_count: 2,
                    last_status: 401,
                    last_refusal: Some(RequestRefusal::Revoked),
                },
                CallerSummary {
                    caller: Some(RequestCaller {
                        client_id: "lifting".to_owned()
                    }),
                    client_address: Some("192.0.2.1".to_owned()),
                    first_seen: at(10),
                    last_seen: at(40),
                    request_count: 3,
                    refused_count: 1,
                    last_status: 200,
                    last_refusal: None,
                },
            ],
            "the group with the newest row first"
        );
    }

    #[test]
    fn a_class_within_its_cap_or_empty_loses_nothing() {
        let store = store();
        assert_eq!(
            store
                .delete_requests_beyond_cap(CallerClass::Verified, 1)
                .expect("trim an empty log"),
            0
        );
        store
            .insert_requests(&[forwarded_request(None, SystemTime::now())])
            .expect("insert");
        assert_eq!(
            store
                .delete_requests_beyond_cap(CallerClass::Unverified, 1)
                .expect("trim"),
            0
        );
        assert_eq!(rows(&store).len(), 1);
    }
}
