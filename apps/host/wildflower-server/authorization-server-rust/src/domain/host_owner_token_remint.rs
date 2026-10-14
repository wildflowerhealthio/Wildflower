//! [`HostOwnerTokenRemintingRevocation`] — the [`Revocation`] port that keeps
//! the Wildflower host app signed in through a revocation of its own subject.
//!
//! The host owner token's subject is the host app's `client_id`, so revoking
//! that subject (a subject-wide revocation, or revoking one of the client's
//! grants, which bumps the same epoch) kills the token the host app is holding.
//! Every capability that revokes goes through this port, which then asks the
//! re-minter `setup_authorization_server` spawns to mint and publish a fresh
//! host owner token at once rather than at its next hourly tick.

use std::sync::Arc;

use chrono::{DateTime, Utc};
use tokio::sync::Notify;

use crate::ports::Revocation;

/// The [`Revocation`] port that, after revoking the Wildflower host app's
/// subject, asks for a fresh host owner token through `host_owner_token_remints`.
/// Every revocation passes through unchanged.
pub(crate) struct HostOwnerTokenRemintingRevocation {
    revocation: Arc<dyn Revocation>,
    wildflower_host_app_client_id: Arc<str>,
    host_owner_token_remints: Arc<Notify>,
}

impl HostOwnerTokenRemintingRevocation {
    /// `revocation`, asking `host_owner_token_remints` for a fresh host owner
    /// token whenever it revokes `wildflower_host_app_client_id`'s subject.
    pub(crate) fn new(
        revocation: Arc<dyn Revocation>,
        wildflower_host_app_client_id: Arc<str>,
        host_owner_token_remints: Arc<Notify>,
    ) -> Self {
        HostOwnerTokenRemintingRevocation {
            revocation,
            wildflower_host_app_client_id,
            host_owner_token_remints,
        }
    }
}

impl Revocation for HostOwnerTokenRemintingRevocation {
    fn revoke_jti(&self, jti: &str, expires_at: DateTime<Utc>, reason: &str) -> Result<(), String> {
        self.revocation.revoke_jti(jti, expires_at, reason)
    }

    fn revoke_subject_as_of_now(&self, subject: &str) -> Result<(), String> {
        self.revocation.revoke_subject_as_of_now(subject)?;
        if subject == &*self.wildflower_host_app_client_id {
            // Stores a permit when the re-minter is busy, so a revocation that
            // lands mid-mint still gets a token minted after it.
            self.host_owner_token_remints.notify_one();
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::time::Duration;

    use super::*;

    const HOST_APP: &str = "wildflower-host";

    /// Records every subject revocation that reaches the store, or fails each
    /// one when `fails` is set.
    #[derive(Default)]
    struct RecordingRevocation {
        revoked_subjects: Mutex<Vec<String>>,
        fails: bool,
    }

    impl Revocation for RecordingRevocation {
        fn revoke_jti(
            &self,
            _jti: &str,
            _expires_at: DateTime<Utc>,
            _reason: &str,
        ) -> Result<(), String> {
            Ok(())
        }

        fn revoke_subject_as_of_now(&self, subject: &str) -> Result<(), String> {
            if self.fails {
                return Err("store unavailable".to_owned());
            }
            self.revoked_subjects
                .lock()
                .unwrap()
                .push(subject.to_owned());
            Ok(())
        }
    }

    fn reminting_over(
        store: Arc<RecordingRevocation>,
    ) -> (HostOwnerTokenRemintingRevocation, Arc<Notify>) {
        let remints = Arc::new(Notify::new());
        let revocation =
            HostOwnerTokenRemintingRevocation::new(store, HOST_APP.into(), remints.clone());
        (revocation, remints)
    }

    /// Whether a re-mint has been asked for: a stored permit resolves at once.
    async fn remint_requested(remints: &Notify) -> bool {
        tokio::time::timeout(Duration::from_millis(50), remints.notified())
            .await
            .is_ok()
    }

    #[tokio::test]
    async fn revoking_the_host_app_s_subject_revokes_it_then_asks_for_a_remint() {
        let store = Arc::new(RecordingRevocation::default());
        let (revocation, remints) = reminting_over(store.clone());
        revocation
            .revoke_subject_as_of_now(HOST_APP)
            .expect("revoked");
        assert_eq!(
            *store.revoked_subjects.lock().unwrap(),
            [HOST_APP.to_owned()]
        );
        assert!(remint_requested(&remints).await);
    }

    #[tokio::test]
    async fn revoking_any_other_subject_asks_for_no_remint() {
        let store = Arc::new(RecordingRevocation::default());
        let (revocation, remints) = reminting_over(store.clone());
        revocation
            .revoke_subject_as_of_now("wildflower-owner-browser")
            .expect("revoked");
        assert_eq!(
            *store.revoked_subjects.lock().unwrap(),
            ["wildflower-owner-browser".to_owned()]
        );
        assert!(!remint_requested(&remints).await);
    }

    #[tokio::test]
    async fn a_failed_revocation_bubbles_and_asks_for_no_remint() {
        let store = Arc::new(RecordingRevocation {
            fails: true,
            ..RecordingRevocation::default()
        });
        let (revocation, remints) = reminting_over(store);
        assert_eq!(
            revocation.revoke_subject_as_of_now(HOST_APP),
            Err("store unavailable".to_owned())
        );
        assert!(!remint_requested(&remints).await);
    }
}
