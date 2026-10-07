//! [`RunGate`]: one unit's runs, one at a time, in the order they began.

use std::sync::Arc;

use tokio::sync::{Mutex, OwnedMutexGuard};

/// Admits one run of a unit at a time.
///
/// A stopped run's runtime takes a moment to shut down, and a unit's next run
/// may want what it holds (a port, a file). So every run of a unit waits at the
/// unit's gate, and holds it until its runtime is gone and its `Stopped` is
/// published. A unit's run state therefore never goes backwards and two of its
/// runs never overlap. Each unit has its own gate, so units never wait for each
/// other.
///
/// Waiting runs are admitted in the order they began (the gate is a fair
/// mutex).
#[derive(Clone, Default)]
pub(crate) struct RunGate {
    current_run: Arc<Mutex<()>>,
}

impl RunGate {
    /// Wait until no earlier run holds the gate, then hold it for this run.
    /// The gate opens for the next run when the returned guard drops.
    pub(crate) async fn wait_for_previous_run(&self) -> OwnedMutexGuard<()> {
        Arc::clone(&self.current_run).lock_owned().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::Future;
    use std::task::Poll;
    use std::time::Duration;

    #[tokio::test]
    async fn a_run_waits_until_the_previous_run_releases_the_gate() {
        let gate = RunGate::default();
        let first_run = gate.wait_for_previous_run().await;

        let mut second_run = Box::pin(gate.wait_for_previous_run());
        let first_poll = std::future::poll_fn(|cx| Poll::Ready(second_run.as_mut().poll(cx))).await;
        assert!(
            first_poll.is_pending(),
            "the second run must wait while the first holds the gate"
        );

        drop(first_run);
        tokio::time::timeout(Duration::from_secs(5), second_run)
            .await
            .expect("the second run is admitted once the first releases the gate");
    }

    #[tokio::test]
    async fn separate_gates_never_wait_for_each_other() {
        let first_gate = RunGate::default();
        let second_gate = RunGate::default();
        let _first_run = first_gate.wait_for_previous_run().await;
        tokio::time::timeout(Duration::from_secs(1), second_gate.wait_for_previous_run())
            .await
            .expect("another unit's gate is open");
    }
}
