//! `tunnel_requests` queries — the `SQLite` adapter bodies behind
//! `SqliteTunnelStore`'s [`RequestLogStore`](crate::domain::RequestLogStore)
//! impl. A [`ForwardedRequest`] is flattened into a [`NewTunnelRequestRow`] on
//! the way in.

use chrono::{DateTime, Utc};
use diesel::dsl::max;
use diesel::prelude::*;
use persistence_rust::PooledDieselConnection;
use shared_structures_rust::request_caller::{ForwardedRequest, RequestRefusal};

use crate::db::schema::tunnel_requests;
use crate::domain::{CallerClass, TunnelError};

/// A [`ForwardedRequest`] as one `tunnel_requests` row, ready to insert.
#[derive(Debug, Insertable)]
#[diesel(table_name = tunnel_requests)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
struct NewTunnelRequestRow<'a> {
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

impl<'a> NewTunnelRequestRow<'a> {
    /// Flatten `request` into its row.
    ///
    /// # Errors
    ///
    /// [`TunnelError::Infrastructure`] if the response size or duration doesn't
    /// fit the `INTEGER` column.
    fn from_forwarded_request(request: &'a ForwardedRequest) -> Result<Self, TunnelError> {
        Ok(NewTunnelRequestRow {
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
                .map_err(|e| TunnelError::infrastructure("response size out of range", e))?,
            duration_ms: i64::try_from(request.duration.as_millis())
                .map_err(|e| TunnelError::infrastructure("request duration out of range", e))?,
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

/// Insert `requests` in one multi-row `INSERT`. Backs
/// [`SqliteTunnelStore::insert_requests`](crate::db::SqliteTunnelStore).
///
/// # Errors
///
/// [`TunnelError::Infrastructure`] if a row can't be flattened or the insert
/// fails.
pub(super) fn insert_requests(
    conn: &mut PooledDieselConnection,
    requests: &[ForwardedRequest],
) -> Result<(), TunnelError> {
    let rows = requests
        .iter()
        .map(NewTunnelRequestRow::from_forwarded_request)
        .collect::<Result<Vec<_>, _>>()?;
    diesel::insert_into(tunnel_requests::table)
        .values(&rows)
        .execute(conn)
        .map_err(|e| TunnelError::infrastructure("insert tunnel requests failed", e))?;
    Ok(())
}

/// Delete `caller_class`'s rows at least `row_cap` ids behind its newest one.
/// Reads the class's newest id and deletes below it in one transaction, each
/// through the class's partial index on `id`. Backs
/// [`SqliteTunnelStore::delete_requests_beyond_cap`](crate::db::SqliteTunnelStore).
///
/// # Errors
///
/// [`TunnelError::Infrastructure`] on a read / delete failure.
pub(super) fn delete_requests_beyond_cap(
    conn: &mut PooledDieselConnection,
    caller_class: CallerClass,
    row_cap: i64,
) -> Result<usize, TunnelError> {
    conn.transaction::<_, diesel::result::Error, _>(|conn| match caller_class {
        CallerClass::Verified => {
            let in_class = tunnel_requests::client_id.is_not_null();
            let newest_id: Option<i64> = tunnel_requests::table
                .filter(in_class)
                .select(max(tunnel_requests::id))
                .first(conn)?;
            let Some(newest_id) = newest_id else {
                return Ok(0);
            };
            diesel::delete(
                tunnel_requests::table
                    .filter(in_class)
                    .filter(tunnel_requests::id.le(newest_id - row_cap)),
            )
            .execute(conn)
        }
        CallerClass::Unverified => {
            let in_class = tunnel_requests::client_id.is_null();
            let newest_id: Option<i64> = tunnel_requests::table
                .filter(in_class)
                .select(max(tunnel_requests::id))
                .first(conn)?;
            let Some(newest_id) = newest_id else {
                return Ok(0);
            };
            diesel::delete(
                tunnel_requests::table
                    .filter(in_class)
                    .filter(tunnel_requests::id.le(newest_id - row_cap)),
            )
            .execute(conn)
        }
    })
    .map_err(|e| TunnelError::infrastructure("trim tunnel requests to their cap failed", e))
}

/// Delete every row received before `cutoff`, through the `received_at` index.
/// Backs
/// [`SqliteTunnelStore::delete_requests_received_before`](crate::db::SqliteTunnelStore).
///
/// # Errors
///
/// [`TunnelError::Infrastructure`] on a delete failure.
pub(super) fn delete_requests_received_before(
    conn: &mut PooledDieselConnection,
    cutoff: DateTime<Utc>,
) -> Result<usize, TunnelError> {
    diesel::delete(tunnel_requests::table.filter(tunnel_requests::received_at.lt(cutoff)))
        .execute(conn)
        .map_err(|e| TunnelError::infrastructure("delete expired tunnel requests failed", e))
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::time::{Duration, SystemTime};

    use diesel::prelude::*;
    use shared_structures_rust::request_caller::{ForwardedRequest, RequestCaller};

    use crate::db::schema::tunnel_requests;
    use crate::db::SqliteTunnelStore;

    /// Every logged row's `client_id`, oldest first.
    pub(crate) fn logged_client_ids(store: &SqliteTunnelStore) -> Vec<Option<String>> {
        tunnel_requests::table
            .select(tunnel_requests::client_id)
            .order(tunnel_requests::id)
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

    use shared_structures_rust::request_caller::RequestRefusal;

    use super::test_support::forwarded_request;
    use super::*;
    use crate::db::SqliteTunnelStore;
    use crate::domain::RequestLogStore;

    fn store() -> SqliteTunnelStore {
        SqliteTunnelStore::open_in_memory().expect("open in-memory store")
    }

    /// Every row's `(id, client_id)`, oldest first.
    fn rows(store: &SqliteTunnelStore) -> Vec<(i64, Option<String>)> {
        tunnel_requests::table
            .select((tunnel_requests::id, tunnel_requests::client_id))
            .order(tunnel_requests::id)
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
            tunnel_requests::table
                .select((
                    tunnel_requests::path,
                    tunnel_requests::status,
                    tunnel_requests::duration_ms,
                    tunnel_requests::refusal,
                ))
                .filter(tunnel_requests::id.eq(2))
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
