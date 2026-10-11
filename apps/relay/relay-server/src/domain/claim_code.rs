//! [`ClaimCode`] — a short, single-use code that redeems for a tunnel's name
//! and token, and the [`ClaimCodeHash`] it is stored as.
//!
//! A code is [`ClaimCode::LEN`] characters drawn uniformly from
//! [`ClaimCode::ALPHABET`]: the digits and uppercase letters without `0`,
//! `1`, `I`, `L` and `O`, which are easily mistaken for one another. That is
//! 31⁸ ≈ 8.5 × 10¹¹ codes, about 39.6 bits. It is shown in two groups of four,
//! `ABCD-EFGH`, and read back with or without the dash, in either case.

use std::fmt;

use rand::seq::IndexedRandom;
use rand::Rng;
use sha2::{Digest, Sha256};

/// A claim code, normalised: [`ClaimCode::LEN`] bytes, each one of
/// [`ClaimCode::ALPHABET`]. `Debug` never prints it.
#[derive(Clone, PartialEq, Eq)]
pub struct ClaimCode([u8; ClaimCode::LEN]);

impl ClaimCode {
    /// The characters a code is drawn from.
    pub const ALPHABET: &'static [u8; 31] = b"23456789ABCDEFGHJKMNPQRSTUVWXYZ";
    /// How many characters a code has.
    pub const LEN: usize = 8;
    /// How many characters each of the two displayed groups has.
    const GROUP_LEN: usize = Self::LEN / 2;
    /// What separates the displayed groups.
    const SEPARATOR: char = '-';

    /// A code of [`Self::LEN`] characters drawn uniformly from
    /// [`Self::ALPHABET`] by `rng`, which must be a CSPRNG outside tests.
    pub fn generate<R: Rng + ?Sized>(rng: &mut R) -> Self {
        Self(std::array::from_fn(|_| {
            *Self::ALPHABET
                .choose(rng)
                .expect("the alphabet is not empty")
        }))
    }

    /// The code `input` spells, ignoring surrounding whitespace, case and
    /// the dash between the groups; `None` if it isn't [`Self::LEN`]
    /// characters of [`Self::ALPHABET`].
    #[must_use]
    pub fn parse(input: &str) -> Option<Self> {
        let input = input.trim();
        let input = match input.split_once(Self::SEPARATOR) {
            Some((first, second)) if first.len() == Self::GROUP_LEN => [first, second].concat(),
            Some(_) => return None,
            None => input.to_owned(),
        };
        let bytes: [u8; Self::LEN] = input.as_bytes().try_into().ok()?;
        let normalised = bytes.map(|byte| byte.to_ascii_uppercase());
        normalised
            .iter()
            .all(|byte| Self::ALPHABET.contains(byte))
            .then_some(Self(normalised))
    }

    /// The SHA-256 of the normalised code, which is all the store keeps.
    #[must_use]
    pub fn hash(&self) -> ClaimCodeHash {
        ClaimCodeHash(Sha256::digest(self.0).into())
    }
}

/// The code in two groups, `ABCD-EFGH`, as the operator reads it out.
impl fmt::Display for ClaimCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let (first, second) = self.0.split_at(Self::GROUP_LEN);
        // Every byte is one of `ALPHABET`, so ASCII.
        let group = |bytes: &[u8]| String::from_utf8_lossy(bytes).into_owned();
        write!(f, "{}{}{}", group(first), Self::SEPARATOR, group(second))
    }
}

impl fmt::Debug for ClaimCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ClaimCode(<redacted>)")
    }
}

/// The SHA-256 of a [`ClaimCode`]: how the store keys a code without holding
/// it.
///
/// A plain, fast hash is enough. The code space is small (about 39.6 bits),
/// so no hash, however slow, would stop someone holding the database from
/// recovering a live code offline; but that database already holds every
/// tunnel's token in plain text, which is what a code redeems for, so a
/// recovered code gives them nothing more. Online guessing, the attack that
/// matters, is throttled by `POST /claim`'s rate limits and bounded by the
/// code's short expiry. The hash keeps codes out of the database, its
/// backups and anything that reads its rows.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct ClaimCodeHash(pub [u8; 32]);

impl fmt::Debug for ClaimCodeHash {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ClaimCodeHash(<redacted>)")
    }
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;
    use rand::rngs::StdRng;
    use rand::SeedableRng;

    use super::*;

    /// A code written by hand, from the alphabet.
    fn code(text: &str) -> ClaimCode {
        ClaimCode(text.as_bytes().try_into().unwrap())
    }

    #[test]
    fn the_alphabet_has_no_easily_confused_characters() {
        for confusable in b"01ILO" {
            assert!(!ClaimCode::ALPHABET.contains(confusable));
        }
        let mut sorted = ClaimCode::ALPHABET.to_vec();
        sorted.dedup();
        assert_eq!(sorted.len(), ClaimCode::ALPHABET.len(), "no repeats");
        assert!(ClaimCode::ALPHABET
            .iter()
            .all(|byte| byte.is_ascii_digit() || byte.is_ascii_uppercase()));
    }

    #[test]
    fn displays_in_two_groups() {
        assert_eq!(code("ABCD2345").to_string(), "ABCD-2345");
    }

    #[test]
    fn parses_with_or_without_the_dash_in_either_case() {
        for input in ["ABCD-2345", "abcd-2345", "ABCD2345", " aBcD2345\n"] {
            assert_eq!(ClaimCode::parse(input), Some(code("ABCD2345")), "{input:?}");
        }
    }

    #[test]
    fn refuses_anything_else() {
        for input in [
            "",
            "ABCD-234",
            "ABCD-23456",
            "ABC-D2345",
            "ABCD--2345",
            "ABCD-23-45",
            "ABCD 2345",
            "ABCD-2340",
            "OBCD2345",
            "IBCD2345",
            "LBCD2345",
            "1BCD2345",
            "ÄBCD2345",
            "ABCD234é",
        ] {
            assert_eq!(ClaimCode::parse(input), None, "{input:?}");
        }
    }

    #[test]
    fn the_hash_is_the_sha256_of_the_normalised_code() {
        let expected: [u8; 32] = Sha256::digest(b"ABCD2345").into();
        assert_eq!(code("ABCD2345").hash(), ClaimCodeHash(expected));
        assert_eq!(
            ClaimCode::parse("abcd-2345").unwrap().hash(),
            ClaimCodeHash(expected)
        );
    }

    #[test]
    fn debug_never_prints_the_code() {
        let debug = format!("{:?}", code("ABCD2345"));
        assert!(!debug.contains("ABCD"), "{debug}");
    }

    proptest! {
        /// A generated code is `LEN` characters of the alphabet, displayed
        /// as two groups around a dash.
        #[test]
        fn generated_codes_are_drawn_only_from_the_alphabet(seed: u64) {
            let generated = ClaimCode::generate(&mut StdRng::seed_from_u64(seed));
            prop_assert!(generated.0.iter().all(|byte| ClaimCode::ALPHABET.contains(byte)));
            let shown = generated.to_string();
            prop_assert_eq!(shown.len(), ClaimCode::LEN + 1);
            prop_assert_eq!(shown.find('-'), Some(ClaimCode::LEN / 2));
        }

        /// Whatever case and dash the code is typed in, it reads back as the
        /// code that was shown.
        #[test]
        fn shown_codes_read_back_however_they_are_typed(
            seed: u64,
            lowercase in proptest::collection::vec(any::<bool>(), ClaimCode::LEN),
            with_dash: bool,
        ) {
            let generated = ClaimCode::generate(&mut StdRng::seed_from_u64(seed));
            let typed: String = generated
                .to_string()
                .chars()
                .filter(|&c| with_dash || c != '-')
                .zip(lowercase.iter().cycle())
                .map(|(c, &lower)| if lower { c.to_ascii_lowercase() } else { c })
                .collect();
            prop_assert_eq!(ClaimCode::parse(&typed), Some(generated));
        }

        /// Anything that parses is normalised: it displays as an uppercase
        /// code of the alphabet, which parses back to itself.
        #[test]
        fn whatever_parses_is_a_code_of_the_alphabet(input in "[a-zA-Z0-9-]{0,12}") {
            if let Some(parsed) = ClaimCode::parse(&input) {
                prop_assert!(parsed.0.iter().all(|byte| ClaimCode::ALPHABET.contains(byte)));
                prop_assert_eq!(ClaimCode::parse(&parsed.to_string()), Some(parsed));
            }
        }
    }
}
