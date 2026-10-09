//! Default tunnel names: two words from the EFF short wordlist, hyphenated,
//! e.g. `acorn-shady`.
//!
//! A tunnel name shows up in cleartext SNI and in Certificate Transparency
//! logs, so it is drawn at random and never derived from who the tunnel
//! belongs to. Two words from a list of about 1,300 short ones give about 1.7
//! million names that are easy to read out and type.
//!
//! The list is `eff_short_wordlist_1.txt`, bundled unmodified (CC BY 3.0 US;
//! see `eff_short_wordlist_1.LICENSE.txt` beside it). Its one word that is
//! not plain lowercase letters, `yo-yo`, is skipped, so every name is exactly
//! two words around one hyphen and always a lowercase DNS label.

use std::sync::LazyLock;

use rand::seq::IndexedRandom;
use rand::Rng;

/// The EFF short wordlist 1, one `<dice roll>\t<word>` per line.
const WORDLIST: &str = include_str!("eff_short_wordlist_1.txt");

/// How many names [`generate_unused`] draws before giving up.
pub const MAX_DRAWS: usize = 100;

/// The wordlist's words that are plain lowercase letters.
static WORDS: LazyLock<Vec<&'static str>> = LazyLock::new(|| {
    WORDLIST
        .lines()
        .filter_map(|line| line.split_once('\t'))
        .map(|(_, word)| word)
        .filter(|word| !word.is_empty() && word.bytes().all(|b| b.is_ascii_lowercase()))
        .collect()
});

/// One name: two words drawn from the list, joined by `-`.
pub fn generate<R: Rng + ?Sized>(rng: &mut R) -> String {
    let mut draw = || {
        *WORDS
            .choose(rng)
            .expect("the bundled wordlist is not empty")
    };
    let first = draw();
    let second = draw();
    format!("{first}-{second}")
}

/// A name for which `is_taken` is false, drawing again on a collision, or
/// `None` if [`MAX_DRAWS`] draws all collide.
///
/// # Errors
///
/// Whatever `is_taken` fails with, drawing no further.
pub fn generate_unused<R: Rng + ?Sized, E>(
    rng: &mut R,
    mut is_taken: impl FnMut(&str) -> Result<bool, E>,
) -> Result<Option<String>, E> {
    for _ in 0..MAX_DRAWS {
        let name = generate(rng);
        if !is_taken(&name)? {
            return Ok(Some(name));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::convert::Infallible;

    use proptest::prelude::*;
    use rand::rngs::StdRng;
    use rand::SeedableRng;

    use super::*;
    use rathole_settings_rust::is_dns_label;

    #[test]
    fn the_bundled_list_is_the_eff_short_wordlist_less_one_hyphenated_word() {
        assert_eq!(WORDLIST.lines().count(), 1_296);
        assert_eq!(WORDS.len(), 1_295);
        assert!(!WORDS.contains(&"yo-yo"));
        assert_eq!(WORDS.iter().collect::<HashSet<_>>().len(), WORDS.len());
    }

    proptest! {
        /// Every name is two listed words around one hyphen, and a valid DNS
        /// label.
        #[test]
        fn names_are_two_listed_words_and_a_dns_label(seed: u64) {
            let name = generate(&mut StdRng::seed_from_u64(seed));
            prop_assert!(is_dns_label(&name), "{name}");
            let (first, second) = name.split_once('-').expect("hyphenated");
            prop_assert!(WORDS.contains(&first) && WORDS.contains(&second), "{name}");
        }

        /// Drawing until unused never repeats a name already handed out.
        #[test]
        fn unused_names_never_collide_within_many_draws(seed: u64) {
            let mut rng = StdRng::seed_from_u64(seed);
            let mut names = HashSet::new();
            for _ in 0..2_000 {
                let name = generate_unused(&mut rng, |name| {
                    Ok::<_, Infallible>(names.contains(name))
                })
                .unwrap()
                .expect("a free name");
                prop_assert!(names.insert(name));
            }
        }
    }

    #[test]
    fn generate_unused_gives_up_when_every_name_is_taken() {
        let mut rng = StdRng::seed_from_u64(0);
        assert_eq!(
            generate_unused(&mut rng, |_| Ok::<_, Infallible>(true)),
            Ok(None)
        );
    }
}
