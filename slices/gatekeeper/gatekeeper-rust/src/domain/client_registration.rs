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
use crate::ports::SelfHostedRedirectTopology;

/// How a pending authorization-code request compares against the current
/// `clients` row — the Owner-facing warning the consent prompt renders.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClientRegistration {
    /// The row exists, the `redirect_uri` resolves to an allowlist entry, and
    /// every requested scope is covered by `allowed_scopes`. The only verdict
    /// that may take the existing-grant fast path at `/authorize`.
    Registered,
    /// No row exists for this `client_id`. Nothing is persisted for such a
    /// client until the Owner approves.
    New,
    /// The row exists but the request steps outside it.
    Changed {
        /// The presented `redirect_uri` resolves to no allowlist entry.
        redirect_uri_is_new: bool,
        /// The requested scopes no `allowed_scopes` entry covers, in request
        /// order. Empty when only the redirect changed.
        new_scopes: Vec<String>,
    },
}

impl ClientRegistration {
    /// Whether this request matches the registration exactly — the gate on the
    /// `/authorize` standing-grant fast path.
    pub(crate) fn is_registered(&self) -> bool {
        matches!(self, ClientRegistration::Registered)
    }

    /// Whether approving this request needs the Owner's explicit acknowledgement
    /// that the app (or its redirect / scopes) is new to them.
    pub(crate) fn needs_acknowledgement(&self) -> bool {
        !self.is_registered()
    }

    /// Whether the presented `redirect_uri` resolves to no existing allowlist
    /// entry — true for a `New` client or a `Changed` verdict whose redirect is
    /// new. Used by both the normal consent approval path and the loopback
    /// consent path to decide whether to append the redirect.
    pub(crate) fn redirect_is_new(&self) -> bool {
        matches!(
            self,
            ClientRegistration::New
                | ClientRegistration::Changed {
                    redirect_uri_is_new: true,
                    ..
                }
        )
    }
}

/// The pending authorization-code request to classify, paired with the client
/// row it names and the provenance needed to resolve an app-relative redirect
/// entry.
pub(crate) struct PendingRegistration<'a> {
    /// The current `clients` row, or `None` when the `client_id` is unknown.
    pub(crate) maybe_existing_client: Option<&'a Client>,
    /// The `redirect_uri` the request presented, already parsed.
    pub(crate) redirect_uri: &'a Url,
    /// The whitespace-split requested scopes, in request order.
    pub(crate) requested_scopes: &'a [String],
    /// The request's served origin, parsed — the base an app-relative allowlist
    /// entry resolves against. `None` when it could not be parsed, which simply
    /// makes every relative entry resolve to nothing.
    pub(crate) served_origin: Option<&'a Url>,
    /// The self-hosted app's redirect topology, from the
    /// [`SelfHostedRedirectResolver`](crate::ports::SelfHostedRedirectResolver)
    /// seam; `None` for a client that is not a self-hosted app.
    pub(crate) topology: Option<&'a SelfHostedRedirectTopology>,
}

/// Classify `pending` against its current client row.
///
/// @returns [`New`](ClientRegistration::New) when no row exists,
/// [`Registered`](ClientRegistration::Registered) when the redirect resolves to
/// an allowlist entry and every requested scope is covered, and
/// [`Changed`](ClientRegistration::Changed) otherwise — carrying which of the two
/// stepped outside the registration.
///
/// Scope coverage is the same coverage-aware check the rest of the slice uses
/// ([`scopes_rust::allowed_scope_covers`]): a client allowed a broad scope also
/// covers a narrower same-grammar request. An unparseable scope parses to an
/// `Unknown` scope that only covers itself, so it is reported as new unless the
/// registration lists it verbatim — deliberately, since the Owner should see an
/// unrecognized scope string.
pub(crate) fn classify_registration(pending: &PendingRegistration<'_>) -> ClientRegistration {
    let Some(client) = pending.maybe_existing_client else {
        return ClientRegistration::New;
    };
    let redirect_uri_is_new = !redirect_is_allowlisted(
        client,
        pending.redirect_uri,
        pending.served_origin,
        pending.topology,
    );
    let new_scopes = uncovered_scopes(&client.allowed_scopes, pending.requested_scopes);
    if redirect_uri_is_new || !new_scopes.is_empty() {
        ClientRegistration::Changed {
            redirect_uri_is_new,
            new_scopes,
        }
    } else {
        ClientRegistration::Registered
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
    use crate::domain::client::RegisteredRedirectUri;
    use crate::domain::test_fake::client;
    use proptest::prelude::*;

    fn redirect() -> Url {
        Url::parse("https://example.com/cb").expect("a valid redirect")
    }

    /// Classify against the fixture client (allowlisting `https://example.com/cb`).
    fn classify(
        client: Option<&Client>,
        redirect_uri: &Url,
        scopes: &[&str],
    ) -> ClientRegistration {
        let requested: Vec<String> = scopes.iter().map(|s| (*s).to_owned()).collect();
        classify_registration(&PendingRegistration {
            maybe_existing_client: client,
            redirect_uri,
            requested_scopes: &requested,
            served_origin: None,
            topology: None,
        })
    }

    #[test]
    fn an_unknown_client_is_new() {
        assert_eq!(
            classify(None, &redirect(), &["read"]),
            ClientRegistration::New
        );
    }

    #[test]
    fn an_allowlisted_redirect_with_covered_scopes_is_registered() {
        let client = client("app", &["read"]);
        assert_eq!(
            classify(Some(&client), &redirect(), &["read"]),
            ClientRegistration::Registered
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
            ClientRegistration::Registered
        );
    }

    #[test]
    fn an_unregistered_redirect_is_changed_without_new_scopes() {
        let client = client("app", &["read"]);
        let elsewhere = Url::parse("https://other.example/cb").unwrap();
        assert_eq!(
            classify(Some(&client), &elsewhere, &["read"]),
            ClientRegistration::Changed {
                redirect_uri_is_new: true,
                new_scopes: Vec::new(),
            }
        );
    }

    /// The uncovered scopes are reported in **request** order (not registration
    /// order), and the covered ones are left out.
    #[test]
    fn uncovered_scopes_are_reported_in_request_order() {
        let client = client("app", &["read"]);
        assert_eq!(
            classify(Some(&client), &redirect(), &["write", "read", "admin"]),
            ClientRegistration::Changed {
                redirect_uri_is_new: false,
                new_scopes: vec!["write".to_owned(), "admin".to_owned()],
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
            ClientRegistration::Registered
        );
        assert_eq!(
            classify(Some(&client), &redirect(), &["something else!!"]),
            ClientRegistration::Changed {
                redirect_uri_is_new: false,
                new_scopes: vec!["something else!!".to_owned()],
            }
        );
    }

    /// An app-relative allowlist entry resolves through the self-hosted topology
    /// here exactly as it does at `/authorize` — the shared
    /// [`redirect_is_allowlisted`] — so a self-hosted app's loopback callback is
    /// `Registered`, and the same entry without a topology is not.
    #[test]
    fn an_app_relative_entry_resolves_through_the_topology() {
        let mut app = client("app", &["read"]);
        app.redirect_uris = vec![RegisteredRedirectUri::AppRelative("/".to_owned())];
        let served = Url::parse("http://127.0.0.1:8080").unwrap();
        let callback = Url::parse("http://127.0.0.1:8090/").unwrap();
        let topology = SelfHostedRedirectTopology {
            port: 8090,
            subdomain: "medication".to_owned(),
        };
        let requested = vec!["read".to_owned()];
        assert_eq!(
            classify_registration(&PendingRegistration {
                maybe_existing_client: Some(&app),
                redirect_uri: &callback,
                requested_scopes: &requested,
                served_origin: Some(&served),
                topology: Some(&topology),
            }),
            ClientRegistration::Registered
        );
        assert_eq!(
            classify_registration(&PendingRegistration {
                maybe_existing_client: Some(&app),
                redirect_uri: &callback,
                requested_scopes: &requested,
                served_origin: Some(&served),
                topology: None,
            }),
            ClientRegistration::Changed {
                redirect_uri_is_new: true,
                new_scopes: Vec::new(),
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
        /// nothing is uncovered, and a `Changed` verdict never carries both
        /// "nothing new" flags (that would be `Registered`). The reported
        /// `new_scopes` are always a subset of what was requested, in request
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
            let verdict = classify_registration(&PendingRegistration {
                maybe_existing_client: Some(&app),
                redirect_uri: &redirect(),
                requested_scopes: &requested,
                served_origin: None,
                topology: None,
            });
            let uncovered = uncovered_scopes(&app.allowed_scopes, &requested);
            match verdict {
                ClientRegistration::New => prop_assert!(false, "a known client is never New"),
                ClientRegistration::Registered => {
                    prop_assert!(allowlisted);
                    prop_assert!(uncovered.is_empty());
                }
                ClientRegistration::Changed { redirect_uri_is_new, new_scopes } => {
                    prop_assert_eq!(redirect_uri_is_new, !allowlisted);
                    prop_assert_eq!(&new_scopes, &uncovered);
                    prop_assert!(redirect_uri_is_new || !new_scopes.is_empty());
                    // A subset of the request, in request order.
                    let mut remaining = requested.iter();
                    for new_scope in &new_scopes {
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
                classify_registration(&PendingRegistration {
                    maybe_existing_client: Some(&app),
                    redirect_uri: &redirect(),
                    requested_scopes: &requested,
                    served_origin: None,
                    topology: None,
                }),
                ClientRegistration::Registered,
            );
        }
    }
}
