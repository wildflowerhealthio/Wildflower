//! [`WaitingConsentOpens`]: the consent opens waiting for their server to
//! open them, so a later open for a server ends its earlier one's wait, and a
//! tap on a notification or the app leaving the foreground ends them all.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex, PoisonError};

use tokio::sync::oneshot;

/// The consent opens waiting for their server to open them, at most one per
/// server: for each, by domain, what ends its wait once dropped. Cloning is
/// cheap; every clone is the same set.
#[derive(Clone, Default)]
pub(crate) struct WaitingConsentOpens {
    waiting: Arc<Mutex<HashMap<String, oneshot::Sender<()>>>>,
}

impl WaitingConsentOpens {
    /// The wait of a new open for the server `domain`, which takes the place
    /// of the server's earlier open, ending its wait: resolves once a later
    /// open for the server takes its place, or every wait ends
    /// ([`end_all`](Self::end_all)). Each server has at most one open
    /// waiting, however many opens a server that doesn't run, as one whose
    /// policy is off, gets.
    pub(crate) fn wait_for(&self, domain: &str) -> impl Future<Output = ()> + Send + 'static {
        let (take_over, taken_over) = oneshot::channel();
        // Replacing the earlier open's sender drops it, which ends its wait.
        self.lock().insert(domain.to_owned(), take_over);
        async move {
            // Dropped, or sent nothing ever.
            let _taken_over = taken_over.await;
        }
    }

    /// End every open's wait: a tap on a notification opens the consent it
    /// announced instead, or the app left the foreground, where none can open.
    pub(crate) fn end_all(&self) {
        self.lock().clear();
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, oneshot::Sender<()>>> {
        // Each change is one map insert or clear, which no panic leaves
        // half-done.
        self.waiting.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    /// Whether `wait` has ended, given a moment.
    async fn ended(wait: impl Future<Output = ()>) -> bool {
        tokio::time::timeout(Duration::from_millis(50), wait)
            .await
            .is_ok()
    }

    #[tokio::test]
    async fn a_later_open_ends_only_its_own_server_s_earlier_wait() {
        let opens = WaitingConsentOpens::default();
        let ruth = opens.wait_for("ruth.example");
        let lab = opens.wait_for("lab.example");

        let later = opens.wait_for("ruth.example");

        assert!(ended(ruth).await);
        assert!(!ended(lab).await);
        assert!(!ended(later).await);
    }

    #[tokio::test]
    async fn ending_all_ends_every_wait() {
        let opens = WaitingConsentOpens::default();
        let ruth = opens.wait_for("ruth.example");
        let lab = opens.wait_for("lab.example");

        opens.end_all();

        assert!(ended(ruth).await);
        assert!(ended(lab).await);
    }
}
