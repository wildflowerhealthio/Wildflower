use rand::distributions::{Distribution, Uniform};
use rand::RngCore;

/// Unambiguous consonants used in device-flow user codes — no vowels, no Y, no 0/1/I/O confusables.
pub(crate) const ALPHABET: &[u8] = "BCDFGHJKLMNPQRSTVWXZ".as_bytes();
pub(crate) const BLOCK_LENGTH: usize = 4;
pub(crate) const BLOCK_COUNT: usize = 2;

/// Generate a device-flow user code (e.g. `BCDF-GHJK`) using the unambiguous consonant alphabet.
pub fn generate_oauth_user_code<R: RngCore>(rng: &mut R) -> String {
    let index = Uniform::from(0..ALPHABET.len());
    let mut chars = std::iter::repeat_with(|| ALPHABET[index.sample(rng)] as char);
    let dash_count = BLOCK_COUNT - 1;
    let letter_count = BLOCK_COUNT * BLOCK_LENGTH;
    let mut out = String::with_capacity(letter_count + dash_count);
    for block_idx in 0..BLOCK_COUNT {
        if block_idx > 0 {
            out.push('-');
        }
        out.extend((&mut chars).take(BLOCK_LENGTH));
    }
    out
}

/// Return true if `s` matches the user-code shape: `BLOCK_COUNT` blocks of `BLOCK_LENGTH` `ALPHABET` chars joined by `-`.
#[must_use]
pub fn is_valid_oauth_user_code(s: &str) -> bool {
    let mut blocks_seen = 0usize;
    for part in s.split('-') {
        if blocks_seen >= BLOCK_COUNT
            || part.len() != BLOCK_LENGTH
            || !part.bytes().all(|b| ALPHABET.contains(&b))
        {
            return false;
        }
        blocks_seen += 1;
    }
    blocks_seen == BLOCK_COUNT
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;
    use rand::SeedableRng;

    #[test]
    fn generated_code_is_valid() {
        let mut rng = rand::rngs::StdRng::seed_from_u64(0);
        for _ in 0..1000 {
            let code = generate_oauth_user_code(&mut rng);
            assert!(is_valid_oauth_user_code(&code), "bad code: {code}");
        }
    }

    #[test]
    fn alphabet_is_unambiguous_consonants() {
        // No vowels, no 0/1/I/O confusables, no Y.
        for &c in ALPHABET {
            let c = c as char;
            assert!(c.is_ascii_uppercase());
            assert!(!matches!(c, 'A' | 'E' | 'I' | 'O' | 'U' | 'Y'));
            assert!(!matches!(c, '0' | '1'));
        }
    }

    proptest! {
        /// `[a-z]` and `ALPHABET` (uppercase consonants) are disjoint, so the
        /// per-block alphabet check can never pass
        #[test]
        fn rejects_codes_with_wrong_alphabet(c in "[a-z]{4}-[a-z]{4}") {
            prop_assert!(!is_valid_oauth_user_code(&c));
        }

        /// A dash-less run of valid chars is a single block, so it fails on
        /// block *count* (`blocks_seen == BLOCK_COUNT` is `1 == 2`) regardless
        /// of length — this pins the block-count path, not block-length.
        #[test]
        fn rejects_dashless_codes_on_block_count(s in "[BCDFGHJKLMNPQRSTVWXZ]{3,7}") {
            prop_assert!(!is_valid_oauth_user_code(&s));
        }

        /// Well-formed `BLOCK-BLOCK` shape where at least one block has
        /// the wrong length — the only way to exercise the per-block
        /// `part.len() != BLOCK_LENGTH` check in isolation.
        #[test]
        fn rejects_codes_with_one_wrong_length_block(
            (a, b) in (
                "[BCDFGHJKLMNPQRSTVWXZ]{1,7}",
                "[BCDFGHJKLMNPQRSTVWXZ]{1,7}",
            ).prop_filter(
                "at least one block must differ from BLOCK_LENGTH",
                |(a, b)| a.len() != BLOCK_LENGTH || b.len() != BLOCK_LENGTH,
            )
        ) {
            let code = format!("{a}-{b}");
            prop_assert!(!is_valid_oauth_user_code(&code));
        }

        /// Three well-formed blocks — pins the `blocks_seen >= BLOCK_COUNT`
        /// early return that rejects too many blocks.
        #[test]
        fn rejects_codes_with_too_many_blocks(
            a in "[BCDFGHJKLMNPQRSTVWXZ]{4}",
            b in "[BCDFGHJKLMNPQRSTVWXZ]{4}",
            c in "[BCDFGHJKLMNPQRSTVWXZ]{4}",
        ) {
            let code = format!("{a}-{b}-{c}");
            prop_assert!(!is_valid_oauth_user_code(&code));
        }
    }
}
