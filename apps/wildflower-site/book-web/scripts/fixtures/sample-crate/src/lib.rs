//! A fixture for book-web's tests: items `rust-items.ts` must find.

/// How a request ends.
#[derive(Debug, PartialEq)]
pub enum Outcome {
    /// It was approved.
    Approved,
    #[allow(dead_code)]
    Denied,
}

pub const LIMIT: u32 = 3;

pub struct Counter<T> {
    count: u32,
    tag: T,
}

impl<T> Counter<T> {
    /// A counter at zero.
    pub fn new(tag: T) -> Self {
        Self { count: 0, tag }
    }

    pub fn bump(&mut self) -> Result<u32, Outcome> {
        // Stop at the limit.
        if self.count >= LIMIT {
            return Err(Outcome::Denied);
        }
        self.count += 1;
        let next = self
            .count
            .checked_mul(2)
            .unwrap_or(0);
        Ok(next)
    }
}

pub trait Named {
    fn name(&self) -> String {
        String::from("unnamed")
    }
    fn reset(&mut self);
}

pub trait Resettable {
    fn reset(&mut self);
}

impl Named for Counter<String> {
    fn reset(&mut self) {
        self.count = 0;
    }
}

impl Resettable for Counter<String> {
    fn reset(&mut self) {
        self.count = LIMIT;
    }
}

pub mod nested {
    pub fn helper() -> u32 {
        1
    }

    #[cfg(test)]
    mod tests {
        fn helper() {}
    }
}

fn helper() -> u32 {
    2
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(8))]

    /// A property at the top of the file.
    #[test]
    fn doubling_is_even(n in 0u32..100) {
        prop_assert_eq!((n * 2) % 2, 0);
    }
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    proptest! {
        /// Bumping stops at the limit, however often it's asked.
        #[test]
        fn bump_stays_within_the_limit(steps in 0usize..10, tag in "é[a-z]{0,4}") {
            let mut counter = super::Counter::new(tag);
            for _ in 0..steps {
                let _ = counter.bump();
            }
            prop_assert!(counter.count <= super::LIMIT);
        }

        #[test]
        fn new_starts_at_zero(tag in any::<u8>()) {
            prop_assert_eq!(super::Counter::new(tag).count, 0);
        }
    }
}
