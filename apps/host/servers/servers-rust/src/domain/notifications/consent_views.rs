//! [`ConsentViews`]: the consents showing in a view of the in-app browser, so
//! a consent opened twice at once, as by a tap on its notification and by the
//! return to the foreground that tap brings, shows in one view.

use std::sync::Arc;

use parking_lot::Mutex;

use crate::domain::ConsentKey;

/// The consents showing in a view of the in-app browser, or opening in one,
/// each by its server's domain and its [`ConsentKey`], with the claim that
/// opened its view. Cloning is cheap; every clone is the same set.
#[derive(Debug, Clone, Default)]
pub struct ConsentViews {
    showing: Arc<Mutex<ShowingConsents>>,
}

/// The consents [`ConsentViews`] holds.
#[derive(Debug, Default)]
struct ShowingConsents {
    /// The last claim handed out; every claim gets a new one.
    last_claim: u64,
    /// Each consent showing. A handful at most, one per request the Owner
    /// has open.
    showing: Vec<ShowingConsent>,
}

/// A consent showing in a view, or opening in one.
#[derive(Debug)]
struct ShowingConsent {
    /// Its server's domain.
    domain: String,
    /// The request.
    key: ConsentKey,
    /// The claim that opened its view.
    claim: u64,
}

/// What [`ConsentViews::claim`] does with a consent a view shows, or is
/// opening, already.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IfShowing {
    /// Claim nothing, so no second view opens: as for a tap on the consent's
    /// notification, and each open the host makes itself.
    Skip,
    /// Take the claim over from that view, so a second view opens: as for
    /// the Owner's own Open, since the host doesn't hear a desktop's tab
    /// close.
    TakeOver,
}

impl ConsentViews {
    /// Claim the consent `key` on the server `domain` for a view about to
    /// open; while a view of it shows or opens already, as `if_showing`
    /// says. The claim lasts until it is dropped: once the view closes,
    /// fails to open, or its request is decided or expires.
    #[must_use]
    pub fn claim(
        &self,
        domain: &str,
        key: &ConsentKey,
        if_showing: IfShowing,
    ) -> Option<ConsentViewClaim> {
        let mut consents = self.showing.lock();
        let showing = consents
            .showing
            .iter()
            .position(|showing| showing.domain == domain && showing.key == *key);
        if let Some(index) = showing {
            match if_showing {
                IfShowing::Skip => return None,
                IfShowing::TakeOver => {
                    consents.showing.swap_remove(index);
                }
            }
        }
        consents.last_claim += 1;
        let claim = consents.last_claim;
        consents.showing.push(ShowingConsent {
            domain: domain.to_owned(),
            key: key.clone(),
            claim,
        });
        Some(ConsentViewClaim {
            views: self.clone(),
            domain: domain.to_owned(),
            key: key.clone(),
            claim,
        })
    }

    /// Whether the consent `key` on the server `domain` shows in a view, or
    /// is opening in one.
    #[must_use]
    pub fn is_showing(&self, domain: &str, key: &ConsentKey) -> bool {
        self.showing
            .lock()
            .showing
            .iter()
            .any(|showing| showing.domain == domain && showing.key == *key)
    }
}

/// A consent's claim on the view it opens in, from [`ConsentViews::claim`].
/// Dropping it releases it: the consent no longer shows, unless a later claim
/// took it over, which keeps it.
#[derive(Debug)]
pub struct ConsentViewClaim {
    views: ConsentViews,
    domain: String,
    key: ConsentKey,
    claim: u64,
}

impl Drop for ConsentViewClaim {
    fn drop(&mut self) {
        self.views.showing.lock().showing.retain(|showing| {
            !(showing.domain == self.domain
                && showing.key == self.key
                && showing.claim == self.claim)
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::server_status::tests::{LAB, RUTH};

    fn oauth(id: &str) -> ConsentKey {
        ConsentKey::OAuth { id: id.to_owned() }
    }

    #[test]
    fn a_consent_showing_is_claimed_once_until_its_claim_drops() {
        let views = ConsentViews::default();
        let claim = views.claim(RUTH, &oauth("a"), IfShowing::Skip).unwrap();
        assert!(views.claim(RUTH, &oauth("a"), IfShowing::Skip).is_none());
        assert!(views.claim(RUTH, &oauth("b"), IfShowing::Skip).is_some());
        assert!(views.claim(LAB, &oauth("a"), IfShowing::Skip).is_some());

        drop(claim);
        assert!(views.claim(RUTH, &oauth("a"), IfShowing::Skip).is_some());
    }

    #[test]
    fn a_claim_taken_over_survives_the_earlier_one_s_drop() {
        let views = ConsentViews::default();
        let earlier = views.claim(RUTH, &oauth("a"), IfShowing::Skip).unwrap();
        let later = views.claim(RUTH, &oauth("a"), IfShowing::TakeOver).unwrap();

        drop(earlier);
        assert!(views.is_showing(RUTH, &oauth("a")));
        drop(later);
        assert!(!views.is_showing(RUTH, &oauth("a")));
    }
}
