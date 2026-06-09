use parking_lot::Mutex;
use std::path::Path;
use std::sync::Arc;

pub type DbResult<T> = Result<T, rusqlite::Error>;

/// Lightweight async wrapper around a single `rusqlite::Connection`.
/// Mirrors the `call(|c| ...)` calling convention so handlers stay
/// transport-agnostic. Serializes all queries through one connection
/// behind a mutex, executed on tokio's blocking pool — fine for the
/// gatekeeper's per-request workload.
#[derive(Clone)]
pub struct Connection {
    conn: Arc<Mutex<rusqlite::Connection>>,
}

impl Connection {
    pub fn open(path: &Path) -> DbResult<Self> {
        let conn = rusqlite::Connection::open(path)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    pub fn open_in_memory() -> DbResult<Self> {
        let conn = rusqlite::Connection::open_in_memory()?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    pub async fn call<F, R>(&self, f: F) -> DbResult<R>
    where
        F: FnOnce(&mut rusqlite::Connection) -> DbResult<R> + Send + 'static,
        R: Send + 'static,
    {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || {
            let mut guard = conn.lock();
            f(&mut guard)
        })
        .await
        .expect("blocking task panicked")
    }
}
