//! The **registration verdict** — how a pending authorization-code request
//! compares against the [`clients`](crate::domain::client::Client) row it names,
//! right now.
//!
//! Every client but the first-party host is trusted on first use: an unknown
//! `client_id`, an unregistered `redirect_uri`, or a scope outside
//! `allowed_scopes` is carried to the Owner's consent prompt as a warning rather
//! than rejected at `/authorize`. [`classify_registration`] is the one place that
//! decides which of the three warnings applies, so `/authorize` (which decides
//! whether the redirect may be trusted and whether the standing-grant fast path
//! may run) and the consent read/approve paths (which render the warning and
//! demand an acknowledgement) can never disagree about the same request.
//!
//! The verdict is **derived, never stored**: it is recomputed from the current
//! row on every read, so a prompt loaded after the row moved reflects the move.

use url::Url;

use crate::domain::client::Client;
use crate::domain::client_redirect::redirect_is_allowlisted;

/// Whether the registration an authorization-code request presents (see
/// [`PresentedClientRegistration`]) is accepted as it stands against the current
/// `clients` row — the Owner-facing warning the consent prompt renders.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ClientRegistrationVerdict {
    /// The row exists, the `redirect_uri` is on its allowlist, and
    /// every requested scope is covered by `allowed_scopes`. The only verdict
    /// that may take the existing-grant fast path at `/authorize`.
    Registered,
    /// No row exists for this `client_id`. Nothing is persisted for such a
    /// client until the Owner approves.
    New,
    /// The row exists but the presented registration steps outside it, so
    /// approving would widen the row (for a client trusted on first use).
    WouldWiden {
        /// The presented `redirect_uri` is not on the allowlist.
        redirect_uri_is_new: bool,
        /// The requested scopes no `allowed_scopes` entry covers, in request
        /// order. Empty when only the redirect changed.
        unregistered_requested_scopes: Vec<String>,
    },
}

impl ClientRegistrationVerdict {
    /// Whether this request matches the registration exactly — the gate on the
    /// `/authorize` standing-grant fast path.
    pub(crate) fn is_registered(&self) -> bool {
        matches!(self, ClientRegistrationVerdict::Registered)
    }

    /// Whether the presented `redirect_uri` is outside the registration — always
    /// for a [`New`](Self::New) client, which has no allowlist yet.
    pub(crate) fn redirect_uri_is_new(&self) -> bool {
        match self {
            ClientRegistrationVerdict::Registered => false,
            ClientRegistrationVerdict::New => true,
            ClientRegistrationVerdict::WouldWiden {
                redirect_uri_is_new,
                ..
            } => *redirect_uri_is_new,
        }
    }

    /// Whether approving this request needs the Owner's explicit acknowledgement
    /// that the app (or its redirect / scopes) is new to them.
    pub(crate) fn needs_acknowledgement(&self) -> bool {
        !self.is_registered()
    }
}

/// The client registration an authorization-code request presents (its
/// redirect and scopes), paired with the stored row for its `client_id` it is
/// judged against.
pub(crate) struct PresentedClientRegistration<'a> {
    /// The current `clients` row, or `None` when the `client_id` is unknown.
    pub(crate) maybe_existing_client: Option<&'a Client>,
    /// The `redirect_uri` the request presented, already parsed.
    pub(crate) redirect_uri: &'a Url,
    /// The scopes the request presented, whitespace-split, in request order.
    pub(crate) scopes: &'a [String],
}

/// Classify `presented_registration` against its current client row.
///
/// @returns [`New`](ClientRegistrationVerdict::New) when no row exists,
/// [`Registered`](ClientRegistrationVerdict::Registered) when the redirect is on the
/// allowlist and every requested scope is covered, and
/// [`WouldWiden`](ClientRegistrationVerdict::WouldWiden) otherwise — carrying which of the two
/// stepped outside the registration.
///
/// Scope coverage is the same coverage-aware check the rest of the slice uses
/// ([`scopes_rust::allowed_scope_covers`]): a client allowed a broad scope also
/// covers a narrower same-grammar request. An unparseable scope parses to an
/// `Unknown` scope that only covers itself, so it is reported as new unless the
/// registration lists it verbatim — deliberately, since the Owner should see an
/// unrecognized scope string.
pub(crate) fn classify_registration(
    presented_registration: &PresentedClientRegistration<'_>,
) -> ClientRegistrationVerdict {
    let Some(existing_client) = presented_registration.maybe_existing_client else {
        return ClientRegistrationVerdict::New;
    };
    let redirect_uri_is_new =
        !redirect_is_allowlisted(existing_client, presented_registration.redirect_uri);
    let unregistered_requested_scopes = uncovered_scopes(
        &existing_client.allowed_scopes,
        presented_registration.scopes,
    );
    if redirect_uri_is_new || !unregistered_requested_scopes.is_empty() {
        ClientRegistrationVerdict::WouldWiden {
            redirect_uri_is_new,
            unregistered_requested_scopes,
        }
    } else {
        ClientRegistrationVerdict::Registered
    }
}

/// The `requested` scopes that no `allowed` entry covers, in request order.
pub(crate) fn uncovered_scopes(allowed: &[String], requested: &[String]) -> Vec<String> {
    requested
        .iter()
        .filter(|requested| {
            !allowed
                .iter()
                .any(|allowed| scopes_rust::allowed_scope_covers(allowed, requested))
        })
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::test_fake::client;
    use proptest::prelude::*;

    fn redirect() -> Url {
        Url::parse("https://example.com/cb").expect("a valid redirect")
    }

    /// Classify against the fixture client (allowlisting `https://example.com/cb`).
    fn classify(
        maybe_existing_client: Option<&Client>,
        requested_redirect_uri: &Url,
        scopes: &[&str],
    ) -> ClientRegistrationVerdict {
        let requested: Vec<String> = scopes.iter().map(|s| (*s).to_owned()).collect();
        classify_registration(&PresentedClientRegistration {
            maybe_existing_client,
            redirect_uri: requested_redirect_uri,
            scopes: &requested,
        })
    }

    #[test]
    fn an_unknown_client_is_new() {
        assert_eq!(
            classify(None, &redirect(), &["read"]),
            ClientRegistrationVerdict::New
        );
    }

    #[test]
    fn an_allowlisted_redirect_with_covered_scopes_is_registered() {
        let client = client("app", &["read"]);
        assert_eq!(
            classify(Some(&client), &redirect(), &["read"]),
            ClientRegistrationVerdict::Registered
        );
    }

    /// Coverage, not string equality: a broad registered scope admits the
    /// narrower same-grammar request it covers, exactly as `/authorize`'s
    /// allowlist check does for the first-party client.
    #[test]
    fn a_scope_covered_by_a_broader_registered_scope_is_registered() {
        let client = client("app", &["patient/Observation.rs"]);
        assert_eq!(
            classify(Some(&client), &redirect(), &["patient/Observation.r"]),
            ClientRegistrationVerdict::Registered
        );
    }

    #[test]
    fn an_unregistered_redirect_is_changed_without_new_scopes() {
        let client = client("app", &["read"]);
        let elsewhere = Url::parse("https://other.example/cb").unwrap();
        assert_eq!(
            classify(Some(&client), &elsewhere, &["read"]),
            ClientRegistrationVerdict::WouldWiden {
                redirect_uri_is_new: true,
                unregistered_requested_scopes: Vec::new(),
            }
        );
    }

    /// The redirect is new for an unknown client (it has no allowlist yet) and
    /// for a `WouldWiden` verdict that says so — never for a `Registered` one or
    /// a `WouldWiden` one that only added scopes.
    #[test]
    fn redirect_uri_is_new_follows_the_verdict() {
        assert!(ClientRegistrationVerdict::New.redirect_uri_is_new());
        assert!(!ClientRegistrationVerdict::Registered.redirect_uri_is_new());
        assert!(ClientRegistrationVerdict::WouldWiden {
            redirect_uri_is_new: true,
            unregistered_requested_scopes: Vec::new(),
        }
        .redirect_uri_is_new());
        assert!(!ClientRegistrationVerdict::WouldWiden {
            redirect_uri_is_new: false,
            unregistered_requested_scopes: vec!["write".to_owned()],
        }
        .redirect_uri_is_new());
    }

    /// The uncovered scopes are reported in **request** order (not registration
    /// order), and the covered ones are left out.
    #[test]
    fn uncovered_scopes_are_reported_in_request_order() {
        let client = client("app", &["read"]);
        assert_eq!(
            classify(Some(&client), &redirect(), &["write", "read", "admin"]),
            ClientRegistrationVerdict::WouldWiden {
                redirect_uri_is_new: false,
                unregistered_requested_scopes: vec!["write".to_owned(), "admin".to_owned()],
            }
        );
    }

    /// An unparseable scope string flows through as an `Unknown` scope that
    /// covers only itself: new unless the registration lists it verbatim.
    #[test]
    fn an_unparseable_scope_is_new_unless_registered_verbatim() {
        let client = client("app", &["not a scope!!"]);
        assert_eq!(
            classify(Some(&client), &redirect(), &["not a scope!!"]),
            ClientRegistrationVerdict::Registered
        );
        assert_eq!(
            classify(Some(&client), &redirect(), &["something else!!"]),
            ClientRegistrationVerdict::WouldWiden {
                redirect_uri_is_new: false,
                unregistered_requested_scopes: vec!["something else!!".to_owned()],
            }
        );
    }

    /// Scope strings kept deliberately simple (no grammar metacharacters) so
    /// coverage degenerates to equality and the properties below can be stated
    /// against plain set membership.
    fn arb_plain_scope() -> impl Strategy<Value = String> {
        "[a-z][a-z0-9_]{0,7}"
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(96))]

        /// The verdict is exactly one of the three, and each is decided by the
        /// two facts it reports: `Registered` iff the redirect is allowlisted and
        /// nothing is uncovered, and a `WouldWiden` verdict never carries both
        /// "nothing new" flags (that would be `Registered`). The reported
        /// `unregistered_requested_scopes` are always a subset of what was requested, in request
        /// order.
        #[test]
        fn verdict_agrees_with_what_it_reports(
            registered in prop::collection::vec(arb_plain_scope(), 0..5),
            requested in prop::collection::vec(arb_plain_scope(), 0..5),
            allowlisted in any::<bool>(),
        ) {
            let mut app = client("app", &[]);
            app.allowed_scopes = registered;
            if !allowlisted {
                app.redirect_uris = Vec::new();
            }
            let verdict = classify_registration(&PresentedClientRegistration {
                maybe_existing_client: Some(&app),
                redirect_uri: &redirect(),
                scopes: &requested,
            });
            let uncovered = uncovered_scopes(&app.allowed_scopes, &requested);
            match verdict {
                ClientRegistrationVerdict::New => prop_assert!(false, "a known client is never New"),
                ClientRegistrationVerdict::Registered => {
                    prop_assert!(allowlisted);
                    prop_assert!(uncovered.is_empty());
                }
                ClientRegistrationVerdict::WouldWiden { redirect_uri_is_new, unregistered_requested_scopes } => {
                    prop_assert_eq!(redirect_uri_is_new, !allowlisted);
                    prop_assert_eq!(&unregistered_requested_scopes, &uncovered);
                    prop_assert!(redirect_uri_is_new || !unregistered_requested_scopes.is_empty());
                    // A subset of the request, in request order.
                    let mut remaining = requested.iter();
                    for new_scope in &unregistered_requested_scopes {
                        prop_assert!(remaining.any(|r| r == new_scope));
                    }
                }
            }
        }

        /// Widening the registration to cover everything requested (the exact
        /// union an approval persists) makes the next identical request
        /// `Registered` — the property the fast path relies on.
        #[test]
        fn unioning_the_requested_scopes_makes_the_next_request_registered(
            registered in prop::collection::vec(arb_plain_scope(), 0..5),
            requested in prop::collection::vec(arb_plain_scope(), 0..5),
        ) {
            let mut app = client("app", &[]);
            app.allowed_scopes = registered;
            app.allowed_scopes.extend(requested.iter().cloned());
            prop_assert_eq!(
                classify_registration(&PresentedClientRegistration {
                    maybe_existing_client: Some(&app),
                    redirect_uri: &redirect(),
                    scopes: &requested,
                }),
                ClientRegistrationVerdict::Registered,
            );
        }
    }
}
