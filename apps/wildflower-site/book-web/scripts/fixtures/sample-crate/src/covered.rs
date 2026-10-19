//! A fixture for book-web's tests: the items `coverage.ts` lists.

/// Listed: public.
pub struct Ticket {
    id: u32,
}

/// Not listed: private.
struct Draft;

pub(crate) const LIMIT: u32 = 3;

/// Not listed: visible only to the parent module.
pub(super) fn quiet() {}

impl Ticket {
    pub fn new(id: u32) -> Self {
        Self { id }
    }

    // Listed, with an ordinary comment between it and the attribute.
    #[must_use]
    pub(crate) fn id(&self) -> u32 {
        self.id
    }

    fn private_helper(&self) {}
}

/// Not listed: a trait impl's methods.
impl Default for Ticket {
    fn default() -> Self {
        Self::new(0)
    }
}

#[tokio::test]
async fn an_integration_style_test() {}

#[cfg(test)]
mod tests {
    use super::*;

    /// Not listed: a helper.
    fn at(id: u32) -> Ticket {
        Ticket::new(id)
    }

    #[test]
    fn a_ticket_keeps_its_id() {
        assert_eq!(at(7).id(), 7);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_async_unit_test() {}

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(8))]

        /// Listed: a property test.
        #[test]
        fn a_ticket_keeps_any_id(id in any::<u32>()) {
            prop_assert_eq!(at(id).id(), id);
        }
    }
}
