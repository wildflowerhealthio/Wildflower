//! `SQLite` persistence for the request-log slice — the `SqliteRequestLogStore`
//! adapter (the `SQLite` implementation of the
//! [`RequestLogStore`](crate::domain::RequestLogStore) port: it holds the
//! app-wide diesel r2d2 pool and applies the request-log migrations onto it)
//! plus the `logged_requests` query bodies (`logged_requests`). The diesel
//! `table!` schema lives in `schema`. Built on Diesel over
//! `wildflowerhealthio_persistence::DieselPool` onto the shared database file, mirroring
//! `collector-rust`'s `SqliteRemotesStore`.

pub(crate) mod logged_requests;
mod request_log_store;
mod schema;

pub use request_log_store::SqliteRequestLogStore;
