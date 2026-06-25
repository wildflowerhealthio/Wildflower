//! Random ids for the apps slice — 21-char base62-ish tokens, close enough to
//! nanoid (the TS handler's id source) without pulling in a fresh crate. Two
//! purpose-named mints share one length/alphabet policy so it lives in one
//! place: [`mint_app_id`] for a created app's stable identity, and
//! [`mint_launch_nonce`] for a per-launch SMART `{launch}` nonce.

use rand::distr::Alphanumeric;
use rand::Rng;

/// Length of a minted token, in chars. 21 ASCII alphanumeric chars is ~125 bits
/// of entropy — a collision under sane workloads is astronomically unlikely.
const LEN: usize = 21;

/// Mint a fresh app id — the create handler's stable per-app identity.
pub(crate) fn mint_app_id() -> String {
    random_token()
}

/// Mint a fresh per-launch nonce — the launch handler's `{launch}` value
/// substituted into a SMART app's launch URL.
pub(crate) fn mint_launch_nonce() -> String {
    random_token()
}

/// A 21-char base62-ish random token, sampled fresh from the thread-local
/// CSPRNG on each call.
fn random_token() -> String {
    rand::rng()
        .sample_iter(&Alphanumeric)
        .take(LEN)
        .map(char::from)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minted_tokens_are_alphanumeric_and_21_chars() {
        for token in [mint_app_id(), mint_launch_nonce()] {
            assert_eq!(token.len(), LEN);
            assert!(token.chars().all(|c| c.is_ascii_alphanumeric()));
        }
    }

    #[test]
    fn minted_tokens_dont_repeat_back_to_back() {
        // Not a proof of randomness — just a sanity check that we aren't
        // accidentally pinning to a constant seed.
        assert_ne!(mint_app_id(), mint_app_id());
        assert_ne!(mint_launch_nonce(), mint_launch_nonce());
    }
}
