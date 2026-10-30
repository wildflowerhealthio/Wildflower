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
//! The set follows each code past its redemption: while the session it starts
//! is being stored, until a sign-in that never finished is given up on, and
//! then, until that session expires, which session it started. The base holds
//! each code it minted as a [`SameDeviceSignInCode`], through which it
//! withdraws the code once the view it opened the code in closes, and through
//! which the session ender finds the session to end, or the next run's setup
//! the session to keep. A code withdrawn while its session is being stored
//! signs nobody in: the session never lands.

use std::collections::HashMap;
use std::sync::Arc;

use chrono::{DateTime, Duration, Utc};
use parking_lot::Mutex;

use crate::crypto_util::random_token::token_storage_hash;
use crate::domain::browser_session::BrowserSession;

/// How long a sign-in code stays redeemable after it is minted. The base opens
/// the sign-in URL as soon as it has minted the code, so a minute is plenty.
pub(crate) const SAME_DEVICE_SIGN_IN_CODE_TTL: Duration = Duration::seconds(60);

/// The sign-in codes minted, by hash, each where it stands. One set is built
/// at setup and shared by the base's minter, each code the minter hands out,
/// and the sign-in capability.
pub(crate) struct SameDeviceSignInCodes {
    /// Each code's storage hash, with where it stands.
    sign_in_by_code_hash: Mutex<HashMap<String, CodeSignIn>>,
}

/// Where a minted sign-in code stands.
#[derive(Debug, Clone, PartialEq, Eq)]
enum CodeSignIn {
    /// Minted and not yet presented.
    Outstanding {
        /// When it stops being redeemable.
        expires_at: DateTime<Utc>,
    },
    /// Redeemed, its session being stored.
    SigningIn {
        /// When the sign-in is given up on, as one that never finished.
        expires_at: DateTime<Utc>,
    },
    /// Redeemed, then withdrawn while its session was being stored: the
    /// session never lands.
    WithdrawnWhileSigningIn {
        /// When the sign-in is given up on, as one that never finished.
        expires_at: DateTime<Utc>,
    },
    /// Signed a browser in.
    SignedIn {
        /// The session's `sid`.
        sid: String,
        /// When the session expires, after which it needs no ending.
        expires_at: DateTime<Utc>,
    },
}

impl SameDeviceSignInCodes {
    /// No codes.
    pub(crate) fn new() -> Self {
        SameDeviceSignInCodes {
            sign_in_by_code_hash: Mutex::new(HashMap::new()),
        }
    }

    /// Keep `code` redeemable until [`SAME_DEVICE_SIGN_IN_CODE_TTL`] past `now`. The
    /// codes already expired at `now`, the sign-ins given up on by `now`, and
    /// the sessions already expired at `now`, are dropped, so only live ones
    /// are kept.
    pub(crate) fn insert(&self, code: &str, now: DateTime<Utc>) {
        let mut sign_in_by_code_hash = self.sign_in_by_code_hash.lock();
        sign_in_by_code_hash.retain(|_, sign_in| match sign_in {
            CodeSignIn::Outstanding { expires_at }
            | CodeSignIn::SigningIn { expires_at }
            | CodeSignIn::WithdrawnWhileSigningIn { expires_at }
            | CodeSignIn::SignedIn { expires_at, .. } => *expires_at > now,
        });
        sign_in_by_code_hash.insert(
            token_storage_hash(code),
            CodeSignIn::Outstanding {
                expires_at: now + SAME_DEVICE_SIGN_IN_CODE_TTL,
            },
        );
    }

    /// Redeem `presented`: whether it was outstanding, and unexpired at
    /// `now`. Redeemed, its session is being stored until
    /// [`session_stored`](Self::session_stored) or
    /// [`session_not_stored`](Self::session_not_stored) says how that went,
    /// or, past [`SAME_DEVICE_SIGN_IN_CODE_TTL`] from `now`, the sign-in is
    /// given up on as one that never finished; an expired one is dropped.
    /// Either way it is no longer outstanding, so a code is redeemed at most
    /// once and an expired one is spent by the attempt. The presented code is hashed before the lookup, which
    /// compares hashes, never the code itself.
    pub(crate) fn take(&self, presented: &str, now: DateTime<Utc>) -> bool {
        let mut sign_in_by_code_hash = self.sign_in_by_code_hash.lock();
        let code_hash = token_storage_hash(presented);
        match sign_in_by_code_hash.get(&code_hash) {
            Some(CodeSignIn::Outstanding { expires_at }) if *expires_at > now => {
                sign_in_by_code_hash.insert(
                    code_hash,
                    CodeSignIn::SigningIn {
                        expires_at: now + SAME_DEVICE_SIGN_IN_CODE_TTL,
                    },
                );
                true
            }
            Some(CodeSignIn::Outstanding { .. }) => {
                sign_in_by_code_hash.remove(&code_hash);
                false
            }
            _ => false,
        }
    }

    /// The session the redeemed `code` started has been stored: remember it,
    /// so the code finds its `sid`, and return `true`; or, when the code was
    /// withdrawn meanwhile, or its sign-in given up on, forget the code and
    /// return `false`, for the caller to roll the session back.
    pub(crate) fn session_stored(&self, code: &str, session: &BrowserSession) -> bool {
        let mut sign_in_by_code_hash = self.sign_in_by_code_hash.lock();
        let code_hash = token_storage_hash(code);
        if !matches!(
            sign_in_by_code_hash.get(&code_hash),
            Some(CodeSignIn::SigningIn { .. })
        ) {
            sign_in_by_code_hash.remove(&code_hash);
            return false;
        }
        sign_in_by_code_hash.insert(
            code_hash,
            CodeSignIn::SignedIn {
                sid: session.sid.clone(),
                expires_at: session.expires_at,
            },
        );
        true
    }

    /// The session the redeemed `code` started wasn't stored, its scope
    /// rolled back even after [`session_stored`](Self::session_stored): forget
    /// the code, which is spent. Only the sign-in that [took](Self::take)
    /// `code` says so; another presentation of it leaves its sign-in be. A
    /// code that is outstanding, as one whose presentation was refused before
    /// it was redeemed, stays so.
    pub(crate) fn session_not_stored(&self, code: &str) {
        let mut sign_in_by_code_hash = self.sign_in_by_code_hash.lock();
        let code_hash = token_storage_hash(code);
        if !matches!(
            sign_in_by_code_hash.get(&code_hash),
            Some(CodeSignIn::Outstanding { .. })
        ) {
            sign_in_by_code_hash.remove(&code_hash);
        }
    }

    /// Withdraw `code`: an outstanding code is no longer redeemable, and one
    /// whose session is being stored signs nobody in. A code that signed a
    /// browser in keeps its session, for
    /// [`signed_in_sid`](Self::signed_in_sid) to find.
    pub(crate) fn withdraw(&self, code: &str) {
        let mut sign_in_by_code_hash = self.sign_in_by_code_hash.lock();
        let code_hash = token_storage_hash(code);
        match sign_in_by_code_hash.get(&code_hash) {
            Some(CodeSignIn::Outstanding { .. }) => {
                sign_in_by_code_hash.remove(&code_hash);
            }
            Some(CodeSignIn::SigningIn { expires_at }) => {
                let expires_at = *expires_at;
                sign_in_by_code_hash.insert(
                    code_hash,
                    CodeSignIn::WithdrawnWhileSigningIn { expires_at },
                );
            }
            Some(CodeSignIn::WithdrawnWhileSigningIn { .. } | CodeSignIn::SignedIn { .. })
            | None => {}
        }
    }

    /// The `sid` of the session `code` signed a browser in with, if it signed
    /// one in that hasn't been [forgotten](Self::forget_session).
    pub(crate) fn signed_in_sid(&self, code: &str) -> Option<String> {
        match self
            .sign_in_by_code_hash
            .lock()
            .get(&token_storage_hash(code))
        {
            Some(CodeSignIn::SignedIn { sid, .. }) => Some(sid.clone()),
            _ => None,
        }
    }

    /// Forget the session `code` signed a browser in with, once it has been
    /// ended, so it is ended at most once.
    pub(crate) fn forget_session(&self, code: &str) {
        let mut sign_in_by_code_hash = self.sign_in_by_code_hash.lock();
        let code_hash = token_storage_hash(code);
        if matches!(
            sign_in_by_code_hash.get(&code_hash),
            Some(CodeSignIn::SignedIn { .. })
        ) {
            sign_in_by_code_hash.remove(&code_hash);
        }
    }
}

/// A same-device sign-in code the base minted, as the base holds it: the
/// code, for `/oauth/sign-in?code=…`, with the set of the run that minted it,
/// so it can be withdrawn, and the session it signed in found, after that run
/// has stopped. It holds nothing of the run's store. Its `Debug` leaves the
/// code out.
#[derive(Clone)]
pub struct SameDeviceSignInCode {
    /// The code.
    code: String,
    /// The codes of the run that minted it.
    codes: Arc<SameDeviceSignInCodes>,
}

impl SameDeviceSignInCode {
    /// The code `code`, minted into `codes`.
    pub(crate) fn new(code: String, codes: Arc<SameDeviceSignInCodes>) -> Self {
        SameDeviceSignInCode { code, codes }
    }

    /// The code, for the `code` of `/oauth/sign-in?code=…&next=…`.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.code
    }

    /// Withdraw the code, as the view it was opened in closes: unredeemed, it
    /// is no longer redeemable; redeemed and still signing in, it signs
    /// nobody in. A session it already signed in stands until it is ended.
    pub fn withdraw(&self) {
        self.codes.withdraw(&self.code);
    }

    /// The `sid` of the session the code signed a browser in with, if it
    /// signed one in that hasn't been ended through it.
    pub(crate) fn signed_in_sid(&self) -> Option<String> {
        self.codes.signed_in_sid(&self.code)
    }

    /// Forget the session the code signed in, once it has been ended.
    pub(crate) fn forget_session(&self) {
        self.codes.forget_session(&self.code);
    }
}

impl std::fmt::Debug for SameDeviceSignInCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SameDeviceSignInCode")
            .finish_non_exhaustive()
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
        let sign_in_by_code_hash = codes.sign_in_by_code_hash.lock();
        assert!(!sign_in_by_code_hash.contains_key("code-1"));
        assert!(sign_in_by_code_hash.contains_key(&token_storage_hash("code-1")));
    }

    /// A code that signed a browser in finds its session until the session
    /// is forgotten, and only that code finds it.
    #[test]
    fn a_signed_in_session_is_found_by_its_own_code_until_forgotten() {
        let codes = SameDeviceSignInCodes::new();
        let now = Utc::now();
        let first = BrowserSession::new_same_device_session(vec![], Duration::hours(8), now);
        let second = BrowserSession::new_same_device_session(vec![], Duration::hours(8), now);
        for (code, session) in [("code-1", &first), ("code-2", &second)] {
            codes.insert(code, now);
            assert!(codes.take(code, now));
            assert!(codes.session_stored(code, session));
        }
        codes.withdraw("code-1");
        assert_eq!(
            codes.signed_in_sid("code-1"),
            Some(first.sid),
            "withdrawing keeps a session signed in"
        );
        codes.forget_session("code-1");
        assert_eq!(codes.signed_in_sid("code-1"), None, "forgotten");
        assert_eq!(codes.signed_in_sid("code-3"), None, "signed nobody in");
        assert_eq!(codes.signed_in_sid("code-2"), Some(second.sid));
    }

    /// A withdrawn code that wasn't redeemed is no longer redeemable.
    #[test]
    fn a_withdrawn_code_is_not_taken() {
        let codes = SameDeviceSignInCodes::new();
        let now = Utc::now();
        codes.insert("code-1", now);
        codes.withdraw("code-1");
        assert!(!codes.take("code-1", now));
    }

    /// A code withdrawn while its session is being stored signs nobody in:
    /// the session lands as one to expire, and the code is forgotten.
    #[test]
    fn a_code_withdrawn_while_signing_in_signs_nobody_in() {
        let codes = SameDeviceSignInCodes::new();
        let now = Utc::now();
        let session = BrowserSession::new_same_device_session(vec![], Duration::hours(8), now);
        codes.insert("code-1", now);
        assert!(codes.take("code-1", now));
        codes.withdraw("code-1");
        assert!(!codes.session_stored("code-1", &session));
        assert_eq!(codes.signed_in_sid("code-1"), None);
        assert!(codes.sign_in_by_code_hash.lock().is_empty());
    }

    /// A session that wasn't stored spends its code; a refused presentation
    /// of an outstanding code, before it was redeemed, leaves it redeemable.
    #[test]
    fn a_session_not_stored_spends_only_a_redeemed_code() {
        let codes = SameDeviceSignInCodes::new();
        let now = Utc::now();
        codes.insert("redeemed", now);
        codes.insert("outstanding", now);
        assert!(codes.take("redeemed", now));
        codes.session_not_stored("redeemed");
        codes.session_not_stored("outstanding");
        assert!(!codes.take("redeemed", now));
        assert!(codes.take("outstanding", now));
    }

    /// Minting forgets the sessions that expired by then, and keeps the
    /// codes' hashes, not the codes.
    #[test]
    fn minting_forgets_the_expired_sessions() {
        let codes = SameDeviceSignInCodes::new();
        let now = Utc::now();
        let stale = BrowserSession::new_same_device_session(vec![], Duration::hours(8), now);
        codes.insert("stale", now);
        assert!(codes.take("stale", now));
        assert!(codes.session_stored("stale", &stale));
        codes.insert("fresh", stale.expires_at);
        let sign_in_by_code_hash = codes.sign_in_by_code_hash.lock();
        assert_eq!(sign_in_by_code_hash.len(), 1);
        assert!(sign_in_by_code_hash.contains_key(&token_storage_hash("fresh")));
    }

    /// Minting a code a full lifetime after a redemption gives up on a
    /// sign-in that never finished, withdrawn or not: its entry is dropped,
    /// and a session landing after that signs nobody in.
    #[test]
    fn minting_gives_up_on_the_sign_ins_that_never_finished() {
        let codes = SameDeviceSignInCodes::new();
        let redeemed_at = Utc::now();
        let session =
            BrowserSession::new_same_device_session(vec![], Duration::hours(8), redeemed_at);
        for code in ["signing-in", "withdrawn"] {
            codes.insert(code, redeemed_at);
            assert!(codes.take(code, redeemed_at));
        }
        codes.withdraw("withdrawn");
        codes.insert("fresh", redeemed_at + SAME_DEVICE_SIGN_IN_CODE_TTL);
        {
            let sign_in_by_code_hash = codes.sign_in_by_code_hash.lock();
            assert_eq!(sign_in_by_code_hash.len(), 1);
            assert!(sign_in_by_code_hash.contains_key(&token_storage_hash("fresh")));
        }
        assert!(!codes.session_stored("signing-in", &session));
        assert_eq!(codes.signed_in_sid("signing-in"), None);
    }

    /// Minting a code a full lifetime after another drops the expired one, so
    /// only the fresh one is kept.
    #[test]
    fn minting_drops_the_expired_codes() {
        let codes = SameDeviceSignInCodes::new();
        let minted_at = Utc::now();
        codes.insert("stale", minted_at);
        codes.insert("fresh", minted_at + SAME_DEVICE_SIGN_IN_CODE_TTL);
        let sign_in_by_code_hash = codes.sign_in_by_code_hash.lock();
        assert_eq!(sign_in_by_code_hash.len(), 1);
        assert!(sign_in_by_code_hash.contains_key(&token_storage_hash("fresh")));
    }
}
