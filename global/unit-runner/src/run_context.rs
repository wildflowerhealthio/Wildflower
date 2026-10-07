//! [`RunContext`], what a unit's run is handed to stop by and report through.

use tokio_util::sync::CancellationToken;

use crate::runner::status_board::{RunLiveness, StatusBoard};
use crate::unit::UnitId;

/// What one run of a unit is handed: the signal to stop, and the way to report
/// that it is up and what its detail is.
///
/// Cloning is cheap; every clone reports for the same run. Once the run has
/// stopped, what any clone reports is dropped.
pub struct RunContext<D> {
    unit_id: UnitId,
    shutdown_token: CancellationToken,
    board: StatusBoard<D>,
    run_liveness: RunLiveness,
}

impl<D> Clone for RunContext<D> {
    fn clone(&self) -> Self {
        Self {
            unit_id: self.unit_id.clone(),
            shutdown_token: self.shutdown_token.clone(),
            board: self.board.clone(),
            run_liveness: self.run_liveness.clone(),
        }
    }
}

impl<D: Clone + Send + Sync + 'static> RunContext<D> {
    pub(crate) fn new(
        unit_id: UnitId,
        shutdown_token: CancellationToken,
        board: StatusBoard<D>,
        run_liveness: RunLiveness,
    ) -> Self {
        Self {
            unit_id,
            shutdown_token,
            board,
            run_liveness,
        }
    }

    /// The id of the unit this run belongs to.
    #[must_use]
    pub fn unit_id(&self) -> &UnitId {
        &self.unit_id
    }

    /// Cancelled when the runner stops this run, or the platform revokes the
    /// keep-alive. The unit should wind down and return once it is.
    #[must_use]
    pub fn shutdown_token(&self) -> &CancellationToken {
        &self.shutdown_token
    }

    /// Report that the unit is up: the run state goes from `Starting` to
    /// `Running`. Later calls do nothing.
    pub fn announce_running(&self) {
        self.board
            .publish_running(&self.unit_id, &self.run_liveness);
    }

    /// Report the unit's own status. It is cleared when the run ends.
    pub fn set_detail(&self, detail: D) {
        self.board
            .publish_detail(&self.unit_id, &self.run_liveness, detail);
    }
}
