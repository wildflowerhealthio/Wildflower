//! `launch_contexts` queries — the SMART App Launch contexts
//! ([`LaunchContext`]) minted at an app launch and consumed single-use at
//! `/oauth/authorize`.

use chrono::{DateTime, Utc};
use diesel::prelude::*;
use diesel::sqlite::SqliteConnection;

use crate::domain::gatekeeper_error::GatekeeperError;
use crate::domain::launch_context::LaunchContext;

diesel::table! {
    launch_contexts (nonce) {
        nonce -> Text,
        client_id -> Nullable<Text>,
        patient -> Nullable<Text>,
        created_at -> TimestamptzSqlite,
        expires_at -> TimestamptzSqlite,
        consumed_at -> Nullable<TimestamptzSqlite>,
    }
}

/// Persist a freshly minted launch context.
pub(super) fn insert_launch_context(
    conn: &mut SqliteConnection,
    context: &LaunchContext,
) -> Result<(), GatekeeperError> {
    diesel::insert_into(launch_contexts::table)
        .values(context.clone())
        .execute(conn)
        .map_err(|e| GatekeeperError::infrastructure("insert_launch_context failed", e))?;
    Ok(())
}

/// Stamp the launch `nonce` consumed at `now` and return it, iff it was minted
/// for `client_id` or for any client, is unconsumed, and is unexpired at
/// `now`; otherwise `None` and nothing changes. One conditional
/// `UPDATE … RETURNING`, so the check and the stamp are a single statement
/// under `SQLite`'s write lock: of two racing authorizes presenting the same
/// nonce, exactly one gets the row.
pub(super) fn consume_launch_context(
    conn: &mut SqliteConnection,
    nonce: &str,
    client_id: &str,
    now: DateTime<Utc>,
) -> Result<Option<LaunchContext>, GatekeeperError> {
    diesel::update(
        launch_contexts::table
            .find(nonce)
            .filter(
                launch_contexts::client_id
                    .eq(client_id)
                    .or(launch_contexts::client_id.is_null()),
            )
            .filter(launch_contexts::consumed_at.is_null())
            .filter(launch_contexts::expires_at.gt(now)),
    )
    .set(launch_contexts::consumed_at.eq(now))
    .returning(LaunchContext::as_returning())
    .get_result(conn)
    .optional()
    .map_err(|e| GatekeeperError::infrastructure("consume_launch_context failed", e))
}

/// Delete every launch context that expired at or before `now`, consumed or
/// not, returning how many rows went. An expired context can never be
/// consumed, so nothing reads it again.
pub(super) fn delete_launch_contexts_expired_by(
    conn: &mut SqliteConnection,
    now: DateTime<Utc>,
) -> Result<usize, GatekeeperError> {
    diesel::delete(launch_contexts::table.filter(launch_contexts::expires_at.le(now)))
        .execute(conn)
        .map_err(|e| GatekeeperError::infrastructure("delete_launch_contexts_expired_by failed", e))
}

#[cfg(test)]
mod tests {
    use chrono::Duration;

    use crate::db::SqliteGatekeeperStore;
    use crate::domain::launch_context::{LaunchContext, LAUNCH_CONTEXT_TTL};
    use crate::domain::{GatekeeperStore as _, GatekeeperTx as _};

    fn store() -> SqliteGatekeeperStore {
        SqliteGatekeeperStore::open_in_memory().expect("store")
    }

    /// A minted context round-trips through the table: the consume returns the
    /// row exactly as inserted, now stamped consumed.
    #[test]
    fn a_minted_context_round_trips_through_its_consume() {
        let store = store();
        let now = chrono::Utc::now();
        let context =
            LaunchContext::for_client("nonce-1".to_owned(), "app", Some("pat-1".to_owned()), now);
        store
            .with_connection(|tx| tx.insert_launch_context(&context))
            .expect("insert");

        let consumed_at = now + Duration::seconds(1);
        let consumed = store
            .with_connection(|tx| tx.consume_launch_context("nonce-1", "app", consumed_at))
            .expect("consume")
            .expect("live context");
        let mut expected = context;
        expected.consumed_at = Some(consumed_at);
        assert_eq!(consumed, expected);
    }

    /// A context for any client is stored with no client and consumed once, by
    /// whichever client presents it first.
    #[test]
    fn a_context_for_any_client_is_consumed_once_by_any_client() {
        let store = store();
        let now = chrono::Utc::now();
        let context = LaunchContext::for_any_client("nonce-1".to_owned(), now);
        store
            .with_connection(|tx| tx.insert_launch_context(&context))
            .expect("insert");
        let consume = |client_id: &str| {
            store
                .with_connection(|tx| tx.consume_launch_context("nonce-1", client_id, now))
                .expect("consume")
        };
        let consumed = consume("other-app").expect("any client consumes it");
        assert_eq!(consumed.client_id(), None);
        assert!(consume("app").is_none(), "a second client finds nothing");
    }

    /// Single use: the second consume of the same nonce finds nothing.
    #[test]
    fn a_context_is_consumed_once() {
        let store = store();
        let now = chrono::Utc::now();
        store
            .with_connection(|tx| {
                tx.insert_launch_context(&LaunchContext::for_client(
                    "nonce-1".to_owned(),
                    "app",
                    None,
                    now,
                ))
            })
            .expect("insert");
        let consume = || {
            store
                .with_connection(|tx| tx.consume_launch_context("nonce-1", "app", now))
                .expect("consume")
        };
        assert!(consume().is_some(), "the first consume wins");
        assert!(consume().is_none(), "a replay finds nothing");
    }

    /// A consume for another client, of an unknown nonce, or at or past the
    /// expiry finds nothing — and the first two leave the context consumable by
    /// its own client.
    #[test]
    fn only_the_minted_client_consumes_an_unexpired_context() {
        let store = store();
        let now = chrono::Utc::now();
        store
            .with_connection(|tx| {
                tx.insert_launch_context(&LaunchContext::for_client(
                    "nonce-1".to_owned(),
                    "app",
                    None,
                    now,
                ))
            })
            .expect("insert");
        let consume = |nonce: &str, client_id: &str, at| {
            store
                .with_connection(|tx| tx.consume_launch_context(nonce, client_id, at))
                .expect("consume")
        };
        assert!(consume("nonce-1", "other-app", now).is_none());
        assert!(consume("forged", "app", now).is_none());
        assert!(consume("nonce-1", "app", now + LAUNCH_CONTEXT_TTL).is_none());
        assert!(consume("nonce-1", "app", now).is_some());
    }

    /// The prune deletes contexts expired at or before `now`, consumed or not,
    /// and keeps live ones.
    #[test]
    fn the_prune_deletes_only_expired_contexts() {
        let store = store();
        let now = chrono::Utc::now();
        let expired_at = now - LAUNCH_CONTEXT_TTL;
        store
            .with_connection(|tx| {
                tx.insert_launch_context(&LaunchContext::for_client(
                    "expired".to_owned(),
                    "app",
                    None,
                    expired_at,
                ))?;
                let mut expired_consumed = LaunchContext::for_client(
                    "expired-consumed".to_owned(),
                    "app",
                    None,
                    expired_at,
                );
                expired_consumed.consumed_at = Some(expired_at);
                tx.insert_launch_context(&expired_consumed)?;
                tx.insert_launch_context(&LaunchContext::for_client(
                    "live".to_owned(),
                    "app",
                    None,
                    now,
                ))
            })
            .expect("insert");
        let pruned = store
            .with_connection(|tx| tx.delete_launch_contexts_expired_by(now))
            .expect("prune");
        assert_eq!(pruned, 2);
        assert!(store
            .with_connection(|tx| tx.consume_launch_context("live", "app", now))
            .expect("consume")
            .is_some());
    }
}
