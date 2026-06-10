use rand::RngCore;

pub const ALPHABET: &[u8; 20] = b"BCDFGHJKLMNPQRSTVWXZ";
pub const BLOCK_LENGTH: usize = 4;
pub const BLOCK_COUNT: usize = 2;

const REJECTION_LIMIT: u8 = (256 - (256 % ALPHABET.len())) as u8;

pub fn generate_user_code<R: RngCore>(rng: &mut R) -> String {
    let mut blocks: Vec<String> = Vec::with_capacity(BLOCK_COUNT);
    for _ in 0..BLOCK_COUNT {
        let mut block = String::with_capacity(BLOCK_LENGTH);
        for _ in 0..BLOCK_LENGTH {
            block.push(sample_char(rng) as char);
        }
        blocks.push(block);
    }
    blocks.join("-")
}

fn sample_char<R: RngCore>(rng: &mut R) -> u8 {
    let mut buf = [0u8; 1];
    loop {
        rng.fill_bytes(&mut buf);
        let byte = buf[0];
        if byte < REJECTION_LIMIT {
            return ALPHABET[(byte as usize) % ALPHABET.len()];
        }
    }
}

pub fn is_valid_user_code(s: &str) -> bool {
    let parts: Vec<&str> = s.split('-').collect();
    if parts.len() != BLOCK_COUNT {
        return false;
    }
    for part in parts {
        if part.len() != BLOCK_LENGTH {
            return false;
        }
        if !part.bytes().all(|b| ALPHABET.contains(&b)) {
            return false;
        }
    }
    true
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
            let code = generate_user_code(&mut rng);
            assert!(is_valid_user_code(&code), "bad code: {code}");
        }
    }

    #[test]
    fn alphabet_is_unambiguous_consonants() {
        // No vowels, no 0/1/I/O confusables, no Y.
        for &b in ALPHABET.iter() {
            let c = b as char;
            assert!(c.is_ascii_uppercase());
            assert!(!matches!(c, 'A' | 'E' | 'I' | 'O' | 'U' | 'Y'));
            assert!(!matches!(c, '0' | '1'));
        }
    }

    proptest! {
        #[test]
        fn rejects_codes_with_wrong_alphabet(c in "[a-z]{4}-[a-z]{4}") {
            prop_assert!(!is_valid_user_code(&c));
        }

        #[test]
        fn rejects_codes_with_wrong_block_length(s in "[BCDFGHJKLMNPQRSTVWXZ]{3,7}") {
            // Length without a dash is invalid in all of [3..7].
            prop_assert!(!is_valid_user_code(&s));
        }
    }
}
