//! The run gate: at most one server run at a time, in the order they asked.

use std::sync::Arc;

use tokio::sync::{Mutex, OwnedMutexGuard};

/// Admits one server run at a time.
///
/// The plugin's `stop` cancels a run and returns without waiting for it, and
/// its `start` checks only whether a run is registered, so a stop followed by a
/// start would begin binding the loopback port while the previous run's
/// runtime is still shutting down. Every run therefore waits on the one gate
/// the host shares across runs, and holds it until its server is gone. Every
/// start path (a restart from the page, a foreground resume, the plugin's own
/// auto-start) is ordered by construction.
///
/// Waiting runs are admitted in the order they asked (the gate is a fair
/// mutex).
#[derive(Clone, Default)]
pub struct RunGate {
    current_run: Arc<Mutex<()>>,
}

impl RunGate {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Wait until no earlier run holds the gate, then hold it for this run.
    /// The gate opens for the next run when the returned guard drops.
    pub async fn wait_for_previous_run(&self) -> OwnedMutexGuard<()> {
        Arc::clone(&self.current_run).lock_owned().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn a_run_waits_until_the_previous_run_releases_the_gate() {
        let gate = RunGate::new();
        let first_run = gate.wait_for_previous_run().await;

        let second_gate = gate.clone();
        let mut second_run = tokio::spawn(async move {
            let _second_run = second_gate.wait_for_previous_run().await;
        });
        assert!(
            tokio::time::timeout(Duration::from_millis(50), &mut second_run)
                .await
                .is_err(),
            "the second run must wait while the first holds the gate"
        );

        drop(first_run);
        tokio::time::timeout(Duration::from_secs(5), second_run)
            .await
            .expect("the second run is admitted once the first releases the gate")
            .expect("the second run's task doesn't panic");
    }
}
