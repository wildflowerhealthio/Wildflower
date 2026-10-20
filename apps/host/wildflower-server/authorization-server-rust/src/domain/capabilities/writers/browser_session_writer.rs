//! [`BrowserSessionWriter`] — the writer that starts browser sessions. A
//! session holds a grant and is what the tokens minted under it name as their
//! `sid`, so starting one takes the proof that the browser may hold it: for a
//! same-device session, a redeemed same-device sign-in code; for a paired session,
//! a claimed browser pairing.

use crate::domain::authority::{ClaimedBrowserPairing, RedeemedSameDeviceSignInCode};
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::grant_store::BrowserSessionsTx;

/// Start browser sessions, inside the caller's transaction; the gate is the
/// proof each method takes: a [`RedeemedSameDeviceSignInCode`] for a
/// same-device session, a [`ClaimedBrowserPairing`] for a paired one.
pub(crate) struct BrowserSessionWriter<'a, T: BrowserSessionsTx> {
    /// The caller's open write scope; the session lands with the rest of the
    /// operation or not at all.
    tx: &'a mut T,
}

impl<'a, T: BrowserSessionsTx> BrowserSessionWriter<'a, T> {
    /// A writer inside the caller's transaction `tx`.
    pub(crate) fn within(tx: &'a mut T) -> Self {
        BrowserSessionWriter { tx }
    }

    /// Store the same-device session `redeemed_sign_in_code` starts.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] on a store failure.
    pub(crate) fn start_same_device_session(
        &mut self,
        redeemed_sign_in_code: &RedeemedSameDeviceSignInCode,
    ) -> Result<(), AuthorizationServerError> {
        self.tx
            .insert_browser_session(redeemed_sign_in_code.session())
    }

    /// Store the paired session `claimed_pairing` starts.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] on a store failure.
    pub(crate) fn start_paired_session(
        &mut self,
        claimed_pairing: &ClaimedBrowserPairing,
    ) -> Result<(), AuthorizationServerError> {
        self.tx.insert_browser_session(claimed_pairing.session())
    }
}

#[cfg(test)]
mod tests {
    use crate::domain::grant_store::*;
    use chrono::{Duration, Utc};
    use wildflowerhealthio_scopes::Grant;

    use super::*;
    use crate::domain::same_device_sign_in_codes::SameDeviceSignInCodes;
    use crate::domain::test_fake::FakeGrantStore;

    /// The stored row is exactly the session the redeemed code carries.
    #[test]
    fn start_same_device_session_stores_the_proof_s_session() {
        let store = FakeGrantStore::default();
        let codes = SameDeviceSignInCodes::new();
        let now = Utc::now();
        codes.insert("code-1", now);
        let redeemed = RedeemedSameDeviceSignInCode::redeem(
            &codes,
            "code-1",
            &Grant::parse(["system/*.cruds"]),
            Duration::hours(8),
            now,
        )
        .expect("redeems");
        BrowserSessionWriter::within(&mut store.tx())
            .start_same_device_session(&redeemed)
            .expect("stored");
        assert_eq!(
            store
                .tx()
                .browser_session_by_sid(&redeemed.session().sid)
                .expect("read"),
            Some(redeemed.session().clone())
        );
    }
}
