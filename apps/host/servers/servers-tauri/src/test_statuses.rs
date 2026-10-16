//! The servers' statuses the commands' and the notifications' tests share.

use wildflowerhealthio_servers::ServerDetail;
use wildflowerhealthio_tauri_unit_runner::{RunState, UnitStatus};

/// A server's status whose run isn't reporting, as `run_state`: a run
/// starting, or one running but asked to stop, as for the restart a return to
/// the foreground brings on iOS.
pub(crate) fn not_reporting(run_state: RunState) -> UnitStatus<ServerDetail> {
    UnitStatus {
        run_state,
        running_since: None,
        detail: None,
    }
}
