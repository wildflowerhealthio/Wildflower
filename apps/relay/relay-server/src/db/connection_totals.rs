//! `connection_totals` queries — the `SQLite` adapter bodies behind
//! `SqliteTunnelStore`'s
//! [`ConnectionTotalsStore`](crate::domain::ConnectionTotalsStore) impl. A
//! row is one hour's count of one outcome, the outcome stored by its name
//! ([`Outcome::as_str`]).

use diesel::prelude::*;
use diesel::upsert::excluded;
use wildflowerhealthio_persistence::PooledDieselConnection;

use crate::db::schema::connection_totals;
use crate::domain::{HourlyCount, Outcome, TunnelError};

/// The `connection_totals` row as an insert binds it.
#[derive(Insertable)]
#[diesel(table_name = connection_totals)]
struct NewConnectionTotalRow {
    hour: i64,
    outcome: &'static str,
    count: i64,
}

/// Add each count to its hour and outcome's row, inserting the rows not
/// stored yet, in one immediate transaction. Backs
/// [`SqliteTunnelStore::add_connection_totals`](crate::db::SqliteTunnelStore).
///
/// # Errors
///
/// [`TunnelError::Infrastructure`] on a write failure, or a count too large
/// to store; nothing is added then.
pub(super) fn add_connection_totals(
    conn: &mut PooledDieselConnection,
    counts: &[HourlyCount],
) -> Result<(), TunnelError> {
    let rows = counts
        .iter()
        .map(|counted| {
            Ok(NewConnectionTotalRow {
                hour: counted.hour,
                outcome: counted.outcome.as_str(),
                count: i64::try_from(counted.count).map_err(|e| {
                    TunnelError::infrastructure("a connection count is too large to store", e)
                })?,
            })
        })
        .collect::<Result<Vec<_>, TunnelError>>()?;
    conn.immediate_transaction(|conn| {
        // One statement per row: diesel's SQLite backend has no batch upsert.
        for row in &rows {
            diesel::insert_into(connection_totals::table)
                .values(row)
                .on_conflict((connection_totals::hour, connection_totals::outcome))
                .do_update()
                .set(
                    connection_totals::count
                        .eq(connection_totals::count + excluded(connection_totals::count)),
                )
                .execute(conn)?;
        }
        diesel::QueryResult::Ok(())
    })
    .map_err(|e| TunnelError::infrastructure("storing the connection totals failed", e))
}

/// Delete every row for an hour before `hour`, returning how many. Backs
/// [`SqliteTunnelStore::delete_connection_totals_before`](crate::db::SqliteTunnelStore).
///
/// # Errors
///
/// [`TunnelError::Infrastructure`] on a delete failure.
pub(super) fn delete_connection_totals_before(
    conn: &mut PooledDieselConnection,
    hour: i64,
) -> Result<usize, TunnelError> {
    diesel::delete(connection_totals::table.filter(connection_totals::hour.lt(hour)))
        .execute(conn)
        .map_err(|e| TunnelError::infrastructure("deleting old connection totals failed", e))
}

/// Every row for an hour from `hour` on, oldest hour first and, within an
/// hour, in [`Outcome`] order. Backs
/// [`SqliteTunnelStore::connection_totals_since`](crate::db::SqliteTunnelStore).
///
/// # Errors
///
/// [`TunnelError::Infrastructure`] on a read failure, or a row whose outcome
/// the relay does not know or whose count is negative.
pub(super) fn connection_totals_since(
    conn: &mut PooledDieselConnection,
    hour: i64,
) -> Result<Vec<HourlyCount>, TunnelError> {
    let rows = connection_totals::table
        .filter(connection_totals::hour.ge(hour))
        .select((
            connection_totals::hour,
            connection_totals::outcome,
            connection_totals::count,
        ))
        .load::<(i64, String, i64)>(conn)
        .map_err(|e| TunnelError::infrastructure("reading the connection totals failed", e))?;
    let mut counts = rows
        .into_iter()
        .map(|(hour, outcome, count)| {
            Ok(HourlyCount {
                hour,
                outcome: Outcome::parse(&outcome).ok_or_else(|| {
                    TunnelError::infrastructure("a stored connection outcome is unknown", outcome)
                })?,
                count: u64::try_from(count).map_err(|e| {
                    TunnelError::infrastructure("a stored connection count is negative", e)
                })?,
            })
        })
        .collect::<Result<Vec<_>, TunnelError>>()?;
    counts.sort_by_key(|counted| (counted.hour, counted.outcome));
    Ok(counts)
}

#[cfg(test)]
mod tests {
    use crate::db::SqliteTunnelStore;
    use crate::domain::{ConnectionTotalsStore, HourlyCount, Outcome};

    fn counted(hour: i64, outcome: Outcome, count: u64) -> HourlyCount {
        HourlyCount {
            hour,
            outcome,
            count,
        }
    }

    #[test]
    fn adding_twice_adds_the_counts() {
        let store = SqliteTunnelStore::open_in_memory().unwrap();
        store
            .add_connection_totals(&[
                counted(3600, Outcome::Ok, 2),
                counted(3600, Outcome::TunnelDown, 1),
            ])
            .unwrap();
        store
            .add_connection_totals(&[counted(3600, Outcome::Ok, 3)])
            .unwrap();
        assert_eq!(
            store.connection_totals_since(0).unwrap(),
            [
                counted(3600, Outcome::Ok, 5),
                counted(3600, Outcome::TunnelDown, 1)
            ]
        );
    }

    #[test]
    fn deleting_before_an_hour_keeps_that_hour() {
        let store = SqliteTunnelStore::open_in_memory().unwrap();
        store
            .add_connection_totals(&[
                counted(0, Outcome::Ok, 1),
                counted(3600, Outcome::Ok, 1),
                counted(7200, Outcome::Ok, 1),
            ])
            .unwrap();
        assert_eq!(store.delete_connection_totals_before(3600).unwrap(), 1);
        assert_eq!(
            store.connection_totals_since(0).unwrap(),
            [counted(3600, Outcome::Ok, 1), counted(7200, Outcome::Ok, 1)]
        );
    }

    #[test]
    fn rows_since_an_hour_come_oldest_first_in_outcome_order() {
        let store = SqliteTunnelStore::open_in_memory().unwrap();
        store
            .add_connection_totals(&[
                counted(7200, Outcome::UnknownTunnel, 1),
                counted(3600, Outcome::TunnelDown, 2),
                counted(7200, Outcome::Ok, 3),
                counted(0, Outcome::Ok, 4),
            ])
            .unwrap();
        assert_eq!(
            store.connection_totals_since(3600).unwrap(),
            [
                counted(3600, Outcome::TunnelDown, 2),
                counted(7200, Outcome::Ok, 3),
                counted(7200, Outcome::UnknownTunnel, 1),
            ]
        );
    }
}
