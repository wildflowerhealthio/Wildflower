//! The `FixedScopeCapability` binding — where the generic, store-agnostic
//! capability in [`crate::domain::capabilities`] meets the concrete
//! [`SqliteRequestLogStore`](crate::db::SqliteRequestLogStore) and the
//! `Arc<RequestLogState>` router state. The binding lifts the store handle out
//! of the state (it never hands the capability the whole state), so `domain/`
//! stays free of both `crate::http` and the concrete adapter type. The `Live…`
//! alias is what the `/requests` handlers name in `Scoped<…>`, and [`state`]
//! holds the [`RequestLogState`](state::RequestLogState) the binding builds
//! from.

mod request_log_reader;

pub(crate) use request_log_reader::LiveRequestLogReader;
pub mod state;
