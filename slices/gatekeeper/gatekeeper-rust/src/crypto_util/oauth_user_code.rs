use rand::distributions::{Distribution, Uniform};
use rand::RngCore;

/// Unambiguous consonants used in device-flow user codes — no vowels, no Y, no 0/1/I/O confusables.
pub const ALPHABET: &[u8] = "BCDFGHJKLMNPQRSTVWXZ".as_bytes();
pub const BLOCK_LENGTH: usize = 4;
pub const BLOCK_COUNT: usize = 2;

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
        #[test]
        fn rejects_codes_with_wrong_alphabet(c in "[a-z]{4}-[a-z]{4}") {
            prop_assert!(!is_valid_oauth_user_code(&c));
        }

        #[test]
        fn rejects_codes_with_wrong_block_length(s in "[BCDFGHJKLMNPQRSTVWXZ]{3,7}") {
            // Length without a dash is invalid in all of [3..7].
            prop_assert!(!is_valid_oauth_user_code(&s));
        }
    }
}
