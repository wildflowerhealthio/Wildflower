//! A fixture for book-web's tests: items `{{#item}}` renders.

use crate::covered::Ticket;
use crate::Outcome as Verdict;

/// A pass to the gate, good for [`LIMIT`](crate::LIMIT) uses.
///
/// It holds a [`Ticket`], is made by [`Pass::issue`] and is checked by
/// [`Self::admits`]. A refusal is a [`Verdict`]; [`Missing`][missing] isn't
/// anywhere, [`Vec`](std::vec::Vec) is outside the crate, [`quiet`] is
/// another module's, and [the docs](https://example.org/) are a plain link.
///
/// [missing]: crate::nowhere::Missing
pub struct Pass {
    /// The ticket it was issued for.
    pub ticket: Ticket,
    /// How many times it has been used.
    #[allow(dead_code)]
    uses: u32,
    spare: bool,
}

/// How a pass fares at the gate, for an [`Admission`](crate::Admission).
pub enum Gate {
    /// Through.
    Open,
    Shut {
        reason: String,
    },
}

impl Pass {
    /// Issues a pass for `ticket`.
    ///
    /// # Errors
    ///
    /// Fails with [`Gate::Shut`] when [`Self::admits`] would refuse.
    ///
    /// ## Example
    ///
    /// ```
    /// # let ticket = Ticket::new(1);
    /// let pass = Pass::issue(ticket);
    /// ```
    pub fn issue(ticket: Ticket) -> Result<Self, Gate> {
        let pass = Self { ticket, uses: 0, spare: false };
        if pass.admits() { Ok(pass) } else { Err(Gate::Open) }
    }

    /// Whether it admits its holder: under [`super::LIMIT`] uses.
    pub fn admits(&self) -> bool {
        self.uses < crate::LIMIT
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh pass admits; see [`Pass::admits`].
    #[test]
    fn a_fresh_pass_admits() {
        assert!(Pass::issue(Ticket::new(1)).is_ok());
    }

    #[test]
    fn issuing_keeps_the_ticket() {
        assert_eq!(Pass::issue(Ticket::new(2)).ok().map(|p| p.ticket.id()), Some(2));
    }

    /// A helper named as one in `covered.rs` is, for anchors to tell apart.
    fn at(id: u32) -> Ticket {
        Ticket::new(id)
    }
}
