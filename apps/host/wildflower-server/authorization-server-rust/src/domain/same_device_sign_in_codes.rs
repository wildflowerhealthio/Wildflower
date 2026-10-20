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

use std::collections::HashMap;

use chrono::{DateTime, Duration, Utc};
use parking_lot::Mutex;

use crate::crypto_util::random_token::token_storage_hash;

/// How long a sign-in code stays redeemable after it is minted. The base opens
/// the sign-in URL as soon as it has minted the code, so a minute is plenty.
pub(crate) const SAME_DEVICE_SIGN_IN_CODE_TTL: Duration = Duration::seconds(60);

/// The outstanding sign-in codes, by hash. One set is built at setup and
/// shared by the base's minter and the sign-in capability.
pub(crate) struct SameDeviceSignInCodes {
    /// Each outstanding code's storage hash, with when it expires.
    expiry_by_code_hash: Mutex<HashMap<String, DateTime<Utc>>>,
}

impl SameDeviceSignInCodes {
    /// No outstanding codes.
    pub(crate) fn new() -> Self {
        SameDeviceSignInCodes {
            expiry_by_code_hash: Mutex::new(HashMap::new()),
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
