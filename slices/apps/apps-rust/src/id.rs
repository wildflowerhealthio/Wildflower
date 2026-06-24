//! 21-char base62-ish random ids — close enough to nanoid (the TS handler's
//! id source) without pulling in a fresh crate. Used by the create handler
//! to mint app ids *and* by the launch handler to mint per-launch nonces, so
//! the length/alphabet policy lives in one place rather than two
//! identical-looking copies.

use rand::distr::Alphanumeric;
use rand::Rng;

/// Length of the minted id, in chars. 21 ASCII alphanumeric chars is ~125 bits
/// of entropy — a collision under sane workloads is astronomically unlikely.
const LEN: usize = 21;

/// Mint a 21-char base62-ish random id. Each call samples fresh from the
/// thread-local CSPRNG.
pub(crate) fn random_id_21() -> String {
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
    fn random_id_21_is_alphanumeric_and_21_chars() {
        let id = random_id_21();
        assert_eq!(id.len(), LEN);
        assert!(id.chars().all(|c| c.is_ascii_alphanumeric()));
    }

    #[test]
    fn random_id_21_doesnt_repeat_back_to_back() {
        // Not a proof of randomness — just a sanity check that we aren't
        // accidentally pinning to a constant seed.
        assert_ne!(random_id_21(), random_id_21());
    }
}
