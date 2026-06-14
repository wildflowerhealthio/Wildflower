use parking_lot::{Mutex, MutexGuard};
use std::sync::Arc;

pub type DbResult<T> = Result<T, rusqlite::Error>;

/// Thin sync wrapper around a single `rusqlite::Connection`. Serializes
/// access through a mutex; safe to clone across axum tasks.
#[derive(Clone)]
pub struct Connection {
    conn: Arc<Mutex<rusqlite::Connection>>,
}

impl Connection {
    pub fn from_inner(conn: rusqlite::Connection) -> Self {
        Self {
            conn: Arc::new(Mutex::new(conn)),
        }
    }

    pub fn lock(&self) -> MutexGuard<'_, rusqlite::Connection> {
        self.conn.lock()
    }
}
