//! [`SameDeviceSignInCodes`] — the one-time codes the base signs a browser in as
//! the Owner with, at `GET /oauth/sign-in`. Only the base can mint a code, and
//! the base runs on the server's own device, so redeeming one stands for "this
//! browser is on the Owner's device". Each code is 256 random bits,
//! minted in-process by the
//! [`SameDeviceSignInCodeMinter`](crate::live_bindings::SameDeviceSignInCodeMinter),
//! valid for [`SAME_DEVICE_SIGN_IN_CODE_TTL`] and redeemable once. The codes are kept
//! only in memory, and only as hashes: a restart drops every outstanding code,
//! and reading the server's memory yields none.
//!
//! A code is looked up by its hash, so how long a lookup takes depends only on
//! the hash of what was presented, never on how much of a stored code it
//! matches.
//!
//! Once a code has signed a browser in, the set remembers which session it
//! started, by the code's hash, until that session expires. The base holds the
//! code it minted for a launch, so when the launch's view closes it ends the
//! session by that code. A restart forgets them, and expires every same-device
//! session at once.

use std::collections::HashMap;

use chrono::{DateTime, Duration, Utc};
use parking_lot::Mutex;

use crate::crypto_util::random_token::token_storage_hash;
use crate::domain::browser_session::BrowserSession;

/// How long a sign-in code stays redeemable after it is minted. The base opens
/// the sign-in URL as soon as it has minted the code, so a minute is plenty.
pub(crate) const SAME_DEVICE_SIGN_IN_CODE_TTL: Duration = Duration::seconds(60);

/// The outstanding sign-in codes, by hash, and the sessions the redeemed ones
/// started. One set is built at setup and shared by the base's minter, the
/// sign-in capability and the same-device session ender.
pub(crate) struct SameDeviceSignInCodes {
    /// Each outstanding code's storage hash, with when it expires.
    expiry_by_code_hash: Mutex<HashMap<String, DateTime<Utc>>>,
    /// Each redeemed code's storage hash, with the session it started, until
    /// that session expires.
    signed_in_session_by_code_hash: Mutex<HashMap<String, SignedInSession>>,
}

/// The same-device session a redeemed sign-in code started.
struct SignedInSession {
    /// The session's `sid`.
    sid: String,
    /// When the session expires, after which it needs no ending.
    expires_at: DateTime<Utc>,
}

impl SameDeviceSignInCodes {
    /// No outstanding codes.
    pub(crate) fn new() -> Self {
        SameDeviceSignInCodes {
            expiry_by_code_hash: Mutex::new(HashMap::new()),
            signed_in_session_by_code_hash: Mutex::new(HashMap::new()),
        }
    }

    /// Keep `code` redeemable until [`SAME_DEVICE_SIGN_IN_CODE_TTL`] past `now`. The
    /// codes already expired at `now` are dropped, so only live ones are kept.
    pub(crate) fn insert(&self, code: &str, now: DateTime<Utc>) {
        let mut expiry_by_code_hash = self.expiry_by_code_hash.lock();
        expiry_by_code_hash.retain(|_, expires_at| *expires_at > now);
        expiry_by_code_hash.insert(token_storage_hash(code), now + SAME_DEVICE_SIGN_IN_CODE_TTL);
    }

    /// Take `presented` out of the outstanding codes: whether it was one, and
    /// unexpired at `now`. It is gone afterwards either way, so a code is
    /// redeemed at most once and an expired one is spent by the attempt. The
    /// presented code is hashed before the lookup, which compares hashes,
    /// never the code itself.
    pub(crate) fn take(&self, presented: &str, now: DateTime<Utc>) -> bool {
        self.expiry_by_code_hash
            .lock()
            .remove(&token_storage_hash(presented))
            .is_some_and(|expires_at| expires_at > now)
    }

    /// Remember that the redeemed `code` signed a browser in with `session`,
    /// so [`take_signed_in_sid`](Self::take_signed_in_sid) finds its `sid`.
    /// The sessions already expired when `session` started are forgotten.
    pub(crate) fn record_signed_in_session(&self, code: &str, session: &BrowserSession) {
        let mut signed_in_session_by_code_hash = self.signed_in_session_by_code_hash.lock();
        signed_in_session_by_code_hash
            .retain(|_, signed_in_session| signed_in_session.expires_at > session.created_at);
        signed_in_session_by_code_hash.insert(
            token_storage_hash(code),
            SignedInSession {
                sid: session.sid.clone(),
                expires_at: session.expires_at,
            },
        );
    }

    /// Take the `sid` of the session `code` signed a browser in with, if it
    /// signed one in. It is gone afterwards, so a session is ended by its code
    /// at most once.
    pub(crate) fn take_signed_in_sid(&self, code: &str) -> Option<String> {
        self.signed_in_session_by_code_hash
            .lock()
            .remove(&token_storage_hash(code))
            .map(|signed_in_session| signed_in_session.sid)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The first take of a code succeeds; the second finds nothing.
    #[test]
    fn a_code_is_taken_once() {
        let codes = SameDeviceSignInCodes::new();
        let now = Utc::now();
        codes.insert("code-1", now);
        assert!(codes.take("code-1", now));
        assert!(!codes.take("code-1", now), "a spent code");
    }

    /// An unknown code is refused and leaves the outstanding code redeemable.
    #[test]
    fn an_unknown_code_is_not_taken() {
        let codes = SameDeviceSignInCodes::new();
        let now = Utc::now();
        codes.insert("code-1", now);
        assert!(!codes.take("code-2", now));
        assert!(
            codes.take("code-1", now),
            "the outstanding code is untouched"
        );
    }

    /// A second before its lifetime is up a code redeems; at the end of it,
    /// it doesn't.
    #[test]
    fn a_code_expires_after_its_ttl() {
        let codes = SameDeviceSignInCodes::new();
        let minted_at = Utc::now();
        codes.insert("in-time", minted_at);
        codes.insert("too-late", minted_at);
        assert!(codes.take(
            "in-time",
            minted_at + SAME_DEVICE_SIGN_IN_CODE_TTL - Duration::seconds(1)
        ));
        assert!(!codes.take("too-late", minted_at + SAME_DEVICE_SIGN_IN_CODE_TTL));
    }

    /// After a code is minted, the set holds its hash and not the code.
    #[test]
    fn only_the_hash_is_kept() {
        let codes = SameDeviceSignInCodes::new();
        codes.insert("code-1", Utc::now());
        let expiry_by_code_hash = codes.expiry_by_code_hash.lock();
        assert!(!expiry_by_code_hash.contains_key("code-1"));
        assert!(expiry_by_code_hash.contains_key(&token_storage_hash("code-1")));
    }

    /// A redeemed code's session is found by the code once, and only by that
    /// code.
    #[test]
    fn a_signed_in_session_is_taken_once_by_its_own_code() {
        let codes = SameDeviceSignInCodes::new();
        let now = Utc::now();
        let first = BrowserSession::new_same_device_session(vec![], Duration::hours(8), now);
        let second = BrowserSession::new_same_device_session(vec![], Duration::hours(8), now);
        codes.record_signed_in_session("code-1", &first);
        codes.record_signed_in_session("code-2", &second);
        assert_eq!(codes.take_signed_in_sid("code-1"), Some(first.sid));
        assert_eq!(codes.take_signed_in_sid("code-1"), None, "taken already");
        assert_eq!(codes.take_signed_in_sid("code-3"), None, "signed nobody in");
        assert_eq!(codes.take_signed_in_sid("code-2"), Some(second.sid));
    }

    /// Recording a session forgets those that expired before it started, and
    /// keeps the codes' hashes, not the codes.
    #[test]
    fn recording_a_session_forgets_the_expired_ones() {
        let codes = SameDeviceSignInCodes::new();
        let now = Utc::now();
        let stale = BrowserSession::new_same_device_session(vec![], Duration::hours(8), now);
        let fresh =
            BrowserSession::new_same_device_session(vec![], Duration::hours(8), stale.expires_at);
        codes.record_signed_in_session("stale", &stale);
        codes.record_signed_in_session("fresh", &fresh);
        let signed_in_session_by_code_hash = codes.signed_in_session_by_code_hash.lock();
        assert_eq!(signed_in_session_by_code_hash.len(), 1);
        assert!(signed_in_session_by_code_hash.contains_key(&token_storage_hash("fresh")));
    }

    /// Minting a code a full lifetime after another drops the expired one, so
    /// only the fresh one is kept.
    #[test]
    fn minting_drops_the_expired_codes() {
        let codes = SameDeviceSignInCodes::new();
        let minted_at = Utc::now();
        codes.insert("stale", minted_at);
        codes.insert("fresh", minted_at + SAME_DEVICE_SIGN_IN_CODE_TTL);
        let expiry_by_code_hash = codes.expiry_by_code_hash.lock();
        assert_eq!(expiry_by_code_hash.len(), 1);
        assert!(expiry_by_code_hash.contains_key(&token_storage_hash("fresh")));
    }
}
