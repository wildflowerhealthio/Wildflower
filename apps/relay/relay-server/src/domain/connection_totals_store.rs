//! The [`ConnectionTotalsStore`] **port** — the pure trait the hourly
//! connection totals are kept through. Like the [`TunnelStore`], it speaks
//! only domain types ([`HourlyCount`]) and raises only the opaque
//! [`Infrastructure`](TunnelError::Infrastructure) failure.
//!
//! The `SQLite` adapter, `SqliteTunnelStore` in [`crate::db`], keeps the
//! totals in the same database as the tunnels, in a table with no
//! identifiers: an hour, an outcome and a count.
//!
//! [`TunnelStore`]: crate::domain::TunnelStore

use crate::domain::{HourlyCount, TunnelError};

/// The persistence port for the hourly connection totals.
pub trait ConnectionTotalsStore {
    /// Add each count to the stored count for its hour and outcome, starting
    /// from zero for a pair not yet stored. All or nothing.
    ///
    /// # Errors
    ///
    /// [`TunnelError::Infrastructure`] on a checkout / write failure, in
    /// which case nothing was added.
    fn add_connection_totals(&self, counts: &[HourlyCount]) -> Result<(), TunnelError>;

    /// Delete every count for an hour that starts before `hour` (Unix epoch
    /// seconds). Returns how many rows were deleted.
    ///
    /// # Errors
    ///
    /// [`TunnelError::Infrastructure`] on a checkout / delete failure.
    fn delete_connection_totals_before(&self, hour: i64) -> Result<usize, TunnelError>;

    /// Every stored count for an hour that starts at or after `hour`, oldest
    /// hour first, and within an hour in [`Outcome`](crate::domain::Outcome)
    /// order.
    ///
    /// # Errors
    ///
    /// [`TunnelError::Infrastructure`] on a checkout / read failure, or a
    /// stored outcome or count the relay cannot read.
    fn connection_totals_since(&self, hour: i64) -> Result<Vec<HourlyCount>, TunnelError>;
}
