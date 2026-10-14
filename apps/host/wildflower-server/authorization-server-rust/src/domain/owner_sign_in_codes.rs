//! [`OwnerSignInCodes`] — the one-time codes the base signs a browser in as
//! the Owner with, at `GET /oauth/sign-in`. Each code is 256 random bits,
//! minted in-process by the
//! [`OwnerSignInCodeMinter`](crate::live_bindings::OwnerSignInCodeMinter),
//! valid for [`OWNER_SIGN_IN_CODE_TTL`] and redeemable once. The codes are kept
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
pub(crate) const OWNER_SIGN_IN_CODE_TTL: Duration = Duration::seconds(60);

/// The outstanding sign-in codes, by hash.
pub(crate) struct OwnerSignInCodes {
    /// Each outstanding code's storage hash, with when it expires.
    expiry_by_code_hash: Mutex<HashMap<String, DateTime<Utc>>>,
}

impl OwnerSignInCodes {
    /// No outstanding codes.
    pub(crate) fn new() -> Self {
        OwnerSignInCodes {
            expiry_by_code_hash: Mutex::new(HashMap::new()),
        }
    }

    /// Keep `code` redeemable until [`OWNER_SIGN_IN_CODE_TTL`] past `now`. The
    /// codes already expired at `now` are dropped, so only live ones are kept.
    pub(crate) fn insert(&self, code: &str, now: DateTime<Utc>) {
        let mut expiry_by_code_hash = self.expiry_by_code_hash.lock();
        expiry_by_code_hash.retain(|_, expires_at| *expires_at > now);
        expiry_by_code_hash.insert(token_storage_hash(code), now + OWNER_SIGN_IN_CODE_TTL);
    }

    /// Take `presented` out of the outstanding codes: whether it was one, and
    /// unexpired at `now`. It is gone afterwards either way, so a code is
    /// redeemed at most once.
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

    #[test]
    fn a_code_is_taken_once() {
        let codes = OwnerSignInCodes::new();
        let now = Utc::now();
        codes.insert("code-1", now);
        assert!(codes.take("code-1", now));
        assert!(!codes.take("code-1", now), "a spent code");
    }

    #[test]
    fn an_unknown_code_is_not_taken() {
        let codes = OwnerSignInCodes::new();
        let now = Utc::now();
        codes.insert("code-1", now);
        assert!(!codes.take("code-2", now));
        assert!(
            codes.take("code-1", now),
            "the outstanding code is untouched"
        );
    }

    #[test]
    fn a_code_expires_after_its_ttl() {
        let codes = OwnerSignInCodes::new();
        let minted_at = Utc::now();
        codes.insert("in-time", minted_at);
        codes.insert("too-late", minted_at);
        assert!(codes.take(
            "in-time",
            minted_at + OWNER_SIGN_IN_CODE_TTL - Duration::seconds(1)
        ));
        assert!(!codes.take("too-late", minted_at + OWNER_SIGN_IN_CODE_TTL));
    }

    #[test]
    fn only_the_hash_is_kept() {
        let codes = OwnerSignInCodes::new();
        codes.insert("code-1", Utc::now());
        let expiry_by_code_hash = codes.expiry_by_code_hash.lock();
        assert!(!expiry_by_code_hash.contains_key("code-1"));
        assert!(expiry_by_code_hash.contains_key(&token_storage_hash("code-1")));
    }

    #[test]
    fn minting_drops_the_expired_codes() {
        let codes = OwnerSignInCodes::new();
        let minted_at = Utc::now();
        codes.insert("stale", minted_at);
        codes.insert("fresh", minted_at + OWNER_SIGN_IN_CODE_TTL);
        let expiry_by_code_hash = codes.expiry_by_code_hash.lock();
        assert_eq!(expiry_by_code_hash.len(), 1);
        assert!(expiry_by_code_hash.contains_key(&token_storage_hash("fresh")));
    }
}
