//! [`Unit`], the work the runner runs, and [`UnitId`], the app's key for it.

use std::fmt;
use std::future::Future;

use crate::run_context::RunContext;

/// The app's key for a unit, unique within a runner.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct UnitId(String);

impl UnitId {
    /// The unit id `id`.
    #[must_use]
    pub fn new(id: impl Into<String>) -> Self {
        Self(id.into())
    }

    /// The id as the app wrote it.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for UnitId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl From<&str> for UnitId {
    fn from(id: &str) -> Self {
        Self::new(id)
    }
}

impl From<String> for UnitId {
    fn from(id: String) -> Self {
        Self(id)
    }
}

/// Work the runner can run: something that runs until it is asked to stop, or
/// fails.
///
/// The app's factory builds a fresh unit for each run, so a run's
/// configuration is fixed from its start to its end. Each run happens on its
/// own OS thread and multi-thread tokio runtime; every task the unit spawns
/// lives and dies with its run.
pub trait Unit: Send + 'static {
    /// The unit's own status, such as a connection's liveness or a sync's
    /// progress, which it reports through [`RunContext::set_detail`]. One runner
    /// has one `Detail` type; an app with several kinds of unit makes it an
    /// enum.
    type Detail: Clone + Send + Sync + 'static;

    /// Run until `ctx.shutdown()` is cancelled, or fail.
    ///
    /// Call [`RunContext::running`] once the unit is up. Returning `Ok` without
    /// being asked to stop counts as ending on its own, like an error, and is
    /// restarted while the unit should still run.
    ///
    /// # Errors
    ///
    /// Whatever made the run fail. The runner reports it as the run's error,
    /// formatted as its `{:#}` chain.
    fn run(self, ctx: RunContext<Self::Detail>) -> impl Future<Output = anyhow::Result<()>> + Send;
}
