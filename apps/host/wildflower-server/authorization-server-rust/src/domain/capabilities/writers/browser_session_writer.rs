//! [`BrowserSessionWriter`] — the writer that starts browser sessions. A
//! session holds a grant and is what the tokens minted under it name as their
//! `sid`, so starting one takes the proof that the browser may hold it: for an
//! Owner browser, a redeemed same-device sign-in code.

use crate::domain::authority::RedeemedSameDeviceSignInCode;
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::GrantStore;

/// Start browser sessions. A borrowed view over the store; the gate is the
/// proof each method takes.
pub(crate) struct BrowserSessionWriter<'a, S: GrantStore> {
    store: &'a S,
}

impl<'a, S: GrantStore> BrowserSessionWriter<'a, S> {
    /// A writer over `store`.
    pub(crate) fn over(store: &'a S) -> Self {
        BrowserSessionWriter { store }
    }

    /// Store the Owner browser session `redeemed_sign_in_code` starts.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] on a store failure.
    pub(crate) fn start_owner_session(
        &self,
        redeemed_sign_in_code: &RedeemedSameDeviceSignInCode,
    ) -> Result<(), AuthorizationServerError> {
        self.store
            .insert_browser_session(redeemed_sign_in_code.session())
    }
}

#[cfg(test)]
mod tests {
    use chrono::{Duration, Utc};
    use wildflowerhealthio_scopes::Grant;

    use super::*;
    use crate::domain::same_device_sign_in_codes::SameDeviceSignInCodes;
    use crate::domain::test_fake::FakeGrantStore;

    /// The stored row is exactly the session the redeemed code carries.
    #[test]
    fn start_owner_session_stores_the_proof_s_session() {
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
        BrowserSessionWriter::over(&store)
            .start_owner_session(&redeemed)
            .expect("stored");
        assert_eq!(
            store
                .browser_session_by_sid(&redeemed.session().sid)
                .expect("read"),
            Some(redeemed.session().clone())
        );
    }
}
