//! [`ConsentViews`]: the consents showing in a view of the in-app browser, so
//! a consent opened twice at once, as by a tap on its notification and by the
//! return to the foreground that tap brings, shows in one view.

use std::sync::{Arc, Mutex, PoisonError};

use wildflowerhealthio_servers::ConsentKey;

/// The consents showing in a view of the in-app browser, or opening in one,
/// each by its server's domain and its [`ConsentKey`], with the claim that
/// opened its view. Cloning is cheap; every clone is the same set.
#[derive(Clone, Default)]
pub(crate) struct ConsentViews(Arc<Mutex<ShowingConsents>>);

#[derive(Default)]
struct ShowingConsents {
    /// The last claim handed out; every claim gets a new one.
    last_claim: u64,
    /// Each consent showing: its server's domain, its key, and its claim. A
    /// handful at most, one per request the Owner has open.
    showing: Vec<(String, ConsentKey, u64)>,
}

impl ConsentViews {
    /// Claim the consent `key` on the server `domain` for a view about to
    /// open; `None` while a view of it is showing or opening already. With
    /// `even_if_showing`, as for the Owner's own Open, the claim is taken over
    /// from that view instead. Release the claim once the view closes, fails
    /// to open, or its request is decided or expires.
    pub(crate) fn claim(
        &self,
        domain: &str,
        key: &ConsentKey,
        even_if_showing: bool,
    ) -> Option<ConsentViewClaim> {
        let mut consents = self.lock();
        let showing = consents
            .showing
            .iter()
            .position(|(showing_domain, showing_key, _)| {
                showing_domain == domain && showing_key == key
            });
        if let Some(index) = showing {
            if !even_if_showing {
                return None;
            }
            consents.showing.swap_remove(index);
        }
        consents.last_claim += 1;
        let claim = consents.last_claim;
        consents
            .showing
            .push((domain.to_owned(), key.clone(), claim));
        Some(ConsentViewClaim {
            views: self.clone(),
            domain: domain.to_owned(),
            key: key.clone(),
            claim,
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, ShowingConsents> {
        // Each change is one push or removal, which no panic leaves
        // half-done.
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Whether the consent `key` on the server `domain` is showing.
    #[cfg(test)]
    pub(crate) fn is_showing(&self, domain: &str, key: &ConsentKey) -> bool {
        self.lock()
            .showing
            .iter()
            .any(|(showing_domain, showing_key, _)| showing_domain == domain && showing_key == key)
    }
}

/// A consent's claim on the view it opens in, from [`ConsentViews::claim`].
#[derive(Clone)]
pub(crate) struct ConsentViewClaim {
    views: ConsentViews,
    domain: String,
    key: ConsentKey,
    claim: u64,
}

impl ConsentViewClaim {
    /// The consent's view is gone, or its request settled: it no longer
    /// shows, unless a later claim took it over, which keeps it.
    pub(crate) fn release(&self) {
        self.views.lock().showing.retain(|(domain, key, claim)| {
            !(*domain == self.domain && *key == self.key && *claim == self.claim)
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RUTH: &str = "ruth.relay.example.com";
    const LAB: &str = "lab.rathole.example.com";

    fn oauth(id: &str) -> ConsentKey {
        ConsentKey::OAuth { id: id.to_owned() }
    }

    #[test]
    fn a_consent_showing_is_claimed_once_until_released() {
        let views = ConsentViews::default();
        let claim = views.claim(RUTH, &oauth("a"), false).unwrap();
        assert!(views.claim(RUTH, &oauth("a"), false).is_none());
        assert!(views.claim(RUTH, &oauth("b"), false).is_some());
        assert!(views.claim(LAB, &oauth("a"), false).is_some());

        claim.release();
        assert!(views.claim(RUTH, &oauth("a"), false).is_some());
    }

    #[test]
    fn a_claim_taken_over_survives_the_earlier_one_s_release() {
        let views = ConsentViews::default();
        let earlier = views.claim(RUTH, &oauth("a"), false).unwrap();
        let later = views.claim(RUTH, &oauth("a"), true).unwrap();

        earlier.release();
        assert!(views.is_showing(RUTH, &oauth("a")));
        later.release();
        assert!(!views.is_showing(RUTH, &oauth("a")));
    }
}
