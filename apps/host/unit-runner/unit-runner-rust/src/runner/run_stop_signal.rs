//! [`RunStopSignal`]: how one run is asked to stop, and why.

use std::sync::{Arc, OnceLock};

use tokio_util::sync::CancellationToken;

use crate::status::StopReason;

/// The signal that stops one run, and the reason it stopped for. The run's
/// record in [`UnitRunner`](super::UnitRunner) and the run's supervisor share
/// it; cloning is cheap, and every clone is the same signal.
#[derive(Debug, Clone, Default)]
pub(crate) struct RunStopSignal {
    shutdown_token: CancellationToken,
    /// Set once, by whoever is first: `UnitRunner` asking the run to stop, or
    /// the run ending on its own.
    reason: Arc<OnceLock<StopReason>>,
}

impl RunStopSignal {
    /// Ask the run to stop for `reason`, and return the reason it stops for:
    /// the first one asked for. The reason is set before the token is
    /// cancelled, so whoever sees the token cancelled also sees a reason.
    pub(crate) fn request_stop(&self, reason: StopReason) -> StopReason {
        let first_reason = *self.reason.get_or_init(|| reason);
        self.shutdown_token.cancel();
        first_reason
    }

    /// Why the run stopped, once something has asked it to.
    pub(crate) fn stop_reason(&self) -> Option<StopReason> {
        self.reason.get().copied()
    }

    /// Cancelled once the run is asked to stop.
    pub(crate) fn shutdown_token(&self) -> &CancellationToken {
        &self.shutdown_token
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_reason_wins_and_the_token_is_cancelled() {
        let stop_signal = RunStopSignal::default();
        assert_eq!(stop_signal.stop_reason(), None);
        assert!(!stop_signal.shutdown_token().is_cancelled());

        let clone = stop_signal.clone();
        assert_eq!(
            clone.request_stop(StopReason::Replaced),
            StopReason::Replaced
        );
        assert_eq!(
            stop_signal.request_stop(StopReason::EndedOnItsOwn),
            StopReason::Replaced
        );
        assert_eq!(stop_signal.stop_reason(), Some(StopReason::Replaced));
        assert!(stop_signal.shutdown_token().is_cancelled());
    }
}
