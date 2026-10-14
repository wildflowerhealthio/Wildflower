//! [`HostAppClientLock`] — the one rule that locks the Wildflower host app's
//! client. The host app holds its own Owner token, whose subject is its
//! `client_id`, so bumping that subject's revocation epoch (a subject-wide
//! revocation, or revoking one of the client's grants) would kill the host
//! app's own token and cut the server off from its own app; disabling the
//! client would cut off the host app's way back in.
//!
//! [`HostAppLockedRevocation`] puts the lock in front of the
//! [`Revocation`] port, so every capability that revokes a subject goes
//! through it and only maps the refusal to its `409`. Disabling a client
//! writes no revocation, so [`ClientsDisabler`](crate::domain::capabilities::ClientsDisabler)
//! asks the same lock directly. Revoking a single token by `jti` is never
//! locked.

use std::sync::Arc;

use chrono::{DateTime, Utc};

use crate::ports::{Revocation, SubjectRevocationError};

/// The Wildflower host app's client, which can't be disabled or have its
/// subject revoked.
#[derive(Clone)]
pub(crate) struct HostAppClientLock {
    wildflower_host_app_client_id: Arc<str>,
}

impl HostAppClientLock {
    /// The lock on `wildflower_host_app_client_id`.
    pub(crate) fn new(wildflower_host_app_client_id: Arc<str>) -> Self {
        HostAppClientLock {
            wildflower_host_app_client_id,
        }
    }

    /// Whether `client_id` is the host app's, and so locked.
    pub(crate) fn locks(&self, client_id: &str) -> bool {
        client_id == &*self.wildflower_host_app_client_id
    }
}

/// The [`Revocation`] port behind the [`HostAppClientLock`]: a subject
/// revocation of the host app's client is refused with
/// [`SubjectRevocationError::HostAppClientLocked`] and nothing is written;
/// everything else passes through.
pub(crate) struct HostAppLockedRevocation {
    revocation: Arc<dyn Revocation>,
    lock: HostAppClientLock,
}

impl HostAppLockedRevocation {
    /// `revocation`, behind `lock`.
    pub(crate) fn new(revocation: Arc<dyn Revocation>, lock: HostAppClientLock) -> Self {
        HostAppLockedRevocation { revocation, lock }
    }
}

impl Revocation for HostAppLockedRevocation {
    fn revoke_jti(&self, jti: &str, expires_at: DateTime<Utc>, reason: &str) -> Result<(), String> {
        self.revocation.revoke_jti(jti, expires_at, reason)
    }

    fn revoke_subject_as_of_now(&self, subject: &str) -> Result<(), SubjectRevocationError> {
        if self.lock.locks(subject) {
            return Err(SubjectRevocationError::HostAppClientLocked {
                client_id: subject.to_owned(),
            });
        }
        self.revocation.revoke_subject_as_of_now(subject)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    const HOST_APP: &str = "wildflower-host";

    /// Records every revocation that reaches the store.
    #[derive(Default)]
    struct RecordingRevocation {
        revoked_jtis: Mutex<Vec<String>>,
        revoked_subjects: Mutex<Vec<String>>,
    }

    impl Revocation for RecordingRevocation {
        fn revoke_jti(
            &self,
            jti: &str,
            _expires_at: DateTime<Utc>,
            _reason: &str,
        ) -> Result<(), String> {
            self.revoked_jtis.lock().unwrap().push(jti.to_owned());
            Ok(())
        }

        fn revoke_subject_as_of_now(&self, subject: &str) -> Result<(), SubjectRevocationError> {
            self.revoked_subjects
                .lock()
                .unwrap()
                .push(subject.to_owned());
            Ok(())
        }
    }

    fn locked_over(store: Arc<RecordingRevocation>) -> HostAppLockedRevocation {
        HostAppLockedRevocation::new(store, HostAppClientLock::new(HOST_APP.into()))
    }

    #[test]
    fn the_host_app_s_subject_is_refused_and_nothing_is_written() {
        let store = Arc::new(RecordingRevocation::default());
        assert!(matches!(
            locked_over(store.clone()).revoke_subject_as_of_now(HOST_APP),
            Err(SubjectRevocationError::HostAppClientLocked { client_id }) if client_id == HOST_APP
        ));
        assert!(store.revoked_subjects.lock().unwrap().is_empty());
    }

    #[test]
    fn any_other_subject_is_revoked() {
        let store = Arc::new(RecordingRevocation::default());
        locked_over(store.clone())
            .revoke_subject_as_of_now("wildflower-owner-browser")
            .expect("revoked");
        assert_eq!(
            *store.revoked_subjects.lock().unwrap(),
            ["wildflower-owner-browser".to_owned()]
        );
    }

    #[test]
    fn a_single_token_is_revoked_whoever_holds_it() {
        let store = Arc::new(RecordingRevocation::default());
        locked_over(store.clone())
            .revoke_jti("host-app-jti", Utc::now(), "admin")
            .expect("revoked");
        assert_eq!(
            *store.revoked_jtis.lock().unwrap(),
            ["host-app-jti".to_owned()]
        );
    }

    #[test]
    fn the_lock_names_only_the_host_app() {
        let lock = HostAppClientLock::new(HOST_APP.into());
        assert!(lock.locks(HOST_APP));
        assert!(!lock.locks("wildflower-owner-browser"));
        assert!(!lock.locks("wildflower-host-2"));
    }
}
