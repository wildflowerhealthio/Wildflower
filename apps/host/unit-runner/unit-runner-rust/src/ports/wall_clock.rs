//! [`WallClock`], the clock policies, grace periods and stop times are read on.

use chrono::{DateTime, Utc};

/// The wall clock. Policies are judged on it rather than on `tokio::time`,
/// whose monotonic clock stops while a laptop sleeps.
pub trait WallClock: Send + Sync + 'static {
    /// The current wall-clock instant.
    fn now(&self) -> DateTime<Utc>;
}

/// The system's wall clock.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemClock;

impl WallClock for SystemClock {
    fn now(&self) -> DateTime<Utc> {
        Utc::now()
    }
}
