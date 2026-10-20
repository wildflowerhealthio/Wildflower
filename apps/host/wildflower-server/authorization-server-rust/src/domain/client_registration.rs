//! An authorization-code request **resolved against its client's
//! registration** as it stands now: [`ResolvedCodeRequest`], the one place
//! `/oauth/authorize`, the limited page's Continue, and the consent read and
//! approval learn what the [`clients`](crate::domain::client::Client) row says
//! about a request — its client's name, whether the client is disabled, the
//! **presented client change**, and the scopes an approval may grant.
//!
//! A registration the server defines is fixed: a request is held to it. Every
//! other client is trusted on first use: an unknown `client_id`, an
//! unregistered `redirect_uri`, or a scope outside `allowed_scopes` is carried
//! to the Owner's consent prompt as a warning rather than rejected at
//! `/authorize`. [`PresentedClientChange::from_presented_registration`]
//! decides which of the three applies.
//!
//! The resolution is **derived, never stored**: it is recomputed from the
//! current row on every read, so a prompt loaded after the row moved reflects
//! the move.

use url::Url;

use crate::domain::authority::ApprovableScopes;
use crate::domain::client::Client;

/// What approving an authorization-code request would change in its client's
/// registration: the registration it presents (see
/// [`PresentedClientRegistration`]) judged against the current `clients` row.
/// The consent prompt renders it as the Owner-facing warning.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PresentedClientChange {
    /// The row exists, the `redirect_uri` is on its allowlist, and every
    /// requested scope is covered by `allowed_scopes`: approving changes
    /// nothing. The only change that may take the existing-grant fast path at
    /// `/authorize`.
    NoChange,
    /// No row exists for this `client_id`: approving would create one. Nothing
    /// is persisted for such a client until the Owner approves.
    WouldCreate,
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

impl PresentedClientChange {
    /// Judge `presented_registration` against its current client row.
    ///
    /// @returns [`WouldCreate`](PresentedClientChange::WouldCreate) when no
    /// row exists, [`NoChange`](PresentedClientChange::NoChange) when the
    /// redirect is on the allowlist and every requested scope is covered, and
    /// [`WouldWiden`](PresentedClientChange::WouldWiden) otherwise — carrying
    /// which of the two stepped outside the registration.
    ///
    /// Scope coverage is the same coverage-aware check the rest of the slice
    /// uses ([`wildflowerhealthio_scopes::allowed_scope_covers`]): a client
    /// allowed a broad scope also covers a narrower same-grammar request. An
    /// unparseable scope parses to an `Unknown` scope that only covers itself,
    /// so it is reported as new unless the registration lists it verbatim —
    /// deliberately, since the Owner should see an unrecognized scope string.
    fn from_presented_registration(
        presented_registration: &PresentedClientRegistration<'_>,
    ) -> PresentedClientChange {
        let Some(existing_client) = presented_registration.maybe_existing_client else {
            return PresentedClientChange::WouldCreate;
        };
        let redirect_uri_is_new =
            !existing_client.allows_redirect_uri(presented_registration.redirect_uri);
        let unregistered_requested_scopes = uncovered_scopes(
            &existing_client.allowed_scopes,
            presented_registration.scopes,
        );
        if redirect_uri_is_new || !unregistered_requested_scopes.is_empty() {
            PresentedClientChange::WouldWiden {
                redirect_uri_is_new,
                unregistered_requested_scopes,
            }
        } else {
            PresentedClientChange::NoChange
        }
    }

    /// Whether approving this request would create or widen its client's
    /// registration. A request that would is kept off the `/authorize`
    /// standing-grant fast path, and approving it needs the Owner's explicit
    /// acknowledgement that the app (or its redirect / scopes) is new to them.
    pub(crate) fn would_change_registration(&self) -> bool {
        !matches!(self, PresentedClientChange::NoChange)
    }
}

/// The client registration an authorization-code request presents (its
/// redirect and scopes), paired with the stored row for its `client_id` it is
/// judged against.
struct PresentedClientRegistration<'a> {
    /// The current `clients` row, or `None` when the `client_id` is unknown.
    maybe_existing_client: Option<&'a Client>,
    /// The `redirect_uri` the request presented, already parsed.
    redirect_uri: &'a Url,
    /// The scopes the request presented, whitespace-split, in request order.
    scopes: &'a [String],
}

/// The `requested` scopes that no `allowed` entry covers, in request order.
pub(crate) fn uncovered_scopes(allowed: &[String], requested: &[String]) -> Vec<String> {
    requested
        .iter()
        .filter(|requested| {
            !allowed
                .iter()
                .any(|allowed| wildflowerhealthio_scopes::allowed_scope_covers(allowed, requested))
        })
        .cloned()
        .collect()
}

/// A code request against its client's registration as it stands now: built
/// once per request, by [`resolve`](Self::resolve), from what the request
/// presents and the client's row (`None` for a `client_id` with no
/// registration).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ResolvedCodeRequest {
    client_name: String,
    client_disabled: bool,
    registration_is_fixed: bool,
    redirect_is_registered: bool,
    presented_client_change: PresentedClientChange,
    approvable_scopes: ApprovableScopes,
}

impl ResolvedCodeRequest {
    /// Resolve a request from `client_id` presenting `redirect_uri` and
    /// `requested_scopes` against the client's row `maybe_existing_client`.
    pub(crate) fn resolve(
        client_id: &str,
        redirect_uri: &Url,
        requested_scopes: &[String],
        maybe_existing_client: Option<&Client>,
    ) -> Self {
        let registration_is_fixed =
            maybe_existing_client.is_some_and(Client::is_registration_fixed);
        ResolvedCodeRequest {
            client_name: maybe_existing_client.map_or_else(
                || client_id.to_owned(),
                |existing_client| existing_client.name.clone(),
            ),
            client_disabled: maybe_existing_client
                .is_some_and(|existing_client| existing_client.disabled_at.is_some()),
            registration_is_fixed,
            redirect_is_registered: maybe_existing_client
                .is_some_and(|existing_client| existing_client.allows_redirect_uri(redirect_uri)),
            presented_client_change: PresentedClientChange::from_presented_registration(
                &PresentedClientRegistration {
                    maybe_existing_client,
                    redirect_uri,
                    scopes: requested_scopes,
                },
            ),
            approvable_scopes: ApprovableScopes::for_code(
                requested_scopes,
                maybe_existing_client,
                registration_is_fixed,
            ),
        }
    }

    /// The client's registered name, or its `client_id` while it has no
    /// registration.
    pub(crate) fn client_name(&self) -> &str {
        &self.client_name
    }

    /// Whether the client is disabled: no request of its goes on.
    pub(crate) fn is_client_disabled(&self) -> bool {
        self.client_disabled
    }

    /// Whether the client's registration is fixed (server-defined): the
    /// request is held to it, and approving it writes none.
    pub(crate) fn is_registration_fixed(&self) -> bool {
        self.registration_is_fixed
    }

    /// Whether the client's registration already lists the redirect: the one
    /// case the redirect is trusted with an error.
    pub(crate) fn is_redirect_registered(&self) -> bool {
        self.redirect_is_registered
    }

    /// Whether every requested scope is inside the client's registration.
    pub(crate) fn are_scopes_registered(&self) -> bool {
        match &self.presented_client_change {
            PresentedClientChange::NoChange => true,
            PresentedClientChange::WouldCreate => false,
            PresentedClientChange::WouldWiden {
                unregistered_requested_scopes,
                ..
            } => unregistered_requested_scopes.is_empty(),
        }
    }

    /// What approving the request would change in its client's registration.
    pub(crate) fn presented_client_change(&self) -> &PresentedClientChange {
        &self.presented_client_change
    }

    /// The scopes an approval of the request may grant, and its approval
    /// scopes.
    pub(crate) fn approvable_scopes(&self) -> &ApprovableScopes {
        &self.approvable_scopes
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::test_fake::client;
    use proptest::prelude::*;

    fn redirect() -> Url {
        Url::parse("https://example.com/cb").expect("a valid redirect")
    }

    /// Judge against the fixture client (allowlisting `https://example.com/cb`).
    fn judge(
        maybe_existing_client: Option<&Client>,
        requested_redirect_uri: &Url,
        scopes: &[&str],
    ) -> PresentedClientChange {
        let requested: Vec<String> = scopes.iter().map(|s| (*s).to_owned()).collect();
        PresentedClientChange::from_presented_registration(&PresentedClientRegistration {
            maybe_existing_client,
            redirect_uri: requested_redirect_uri,
            scopes: &requested,
        })
    }

    #[test]
    fn an_unknown_client_would_create_its_registration() {
        assert_eq!(
            judge(None, &redirect(), &["read"]),
            PresentedClientChange::WouldCreate
        );
    }

    #[test]
    fn an_allowlisted_redirect_with_covered_scopes_changes_nothing() {
        let client = client("app", &["read"]);
        assert_eq!(
            judge(Some(&client), &redirect(), &["read"]),
            PresentedClientChange::NoChange
        );
    }

    /// Coverage, not string equality: a broad registered scope admits the
    /// narrower same-grammar request it covers, exactly as `/authorize`'s
    /// allowlist check does for a server-defined registration.
    #[test]
    fn a_scope_covered_by_a_broader_registered_scope_changes_nothing() {
        let client = client("app", &["patient/Observation.rs"]);
        assert_eq!(
            judge(Some(&client), &redirect(), &["patient/Observation.r"]),
            PresentedClientChange::NoChange
        );
    }

    #[test]
    fn an_unregistered_redirect_would_widen_without_new_scopes() {
        let client = client("app", &["read"]);
        let elsewhere = Url::parse("https://other.example/cb").unwrap();
        assert_eq!(
            judge(Some(&client), &elsewhere, &["read"]),
            PresentedClientChange::WouldWiden {
                redirect_uri_is_new: true,
                unregistered_requested_scopes: Vec::new(),
            }
        );
    }

    /// The uncovered scopes are reported in **request** order (not registration
    /// order), and the covered ones are left out.
    #[test]
    fn uncovered_scopes_are_reported_in_request_order() {
        let client = client("app", &["read"]);
        assert_eq!(
            judge(Some(&client), &redirect(), &["write", "read", "admin"]),
            PresentedClientChange::WouldWiden {
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
            judge(Some(&client), &redirect(), &["not a scope!!"]),
            PresentedClientChange::NoChange
        );
        assert_eq!(
            judge(Some(&client), &redirect(), &["something else!!"]),
            PresentedClientChange::WouldWiden {
                redirect_uri_is_new: false,
                unregistered_requested_scopes: vec!["something else!!".to_owned()],
            }
        );
    }

    fn resolve(maybe_existing_client: Option<&Client>, scopes: &[&str]) -> ResolvedCodeRequest {
        let requested: Vec<String> = scopes.iter().map(|s| (*s).to_owned()).collect();
        ResolvedCodeRequest::resolve("app", &redirect(), &requested, maybe_existing_client)
    }

    /// A client with no row is named by its `client_id`, neither disabled nor
    /// fixed, and its redirect untrusted.
    #[test]
    fn an_unknown_client_resolves_as_new_under_its_id() {
        let resolved = resolve(None, &["read"]);
        assert_eq!(resolved.client_name(), "app");
        assert!(!resolved.is_client_disabled());
        assert!(!resolved.is_registration_fixed());
        assert!(!resolved.is_redirect_registered());
        assert!(!resolved.are_scopes_registered());
        assert_eq!(
            resolved.presented_client_change(),
            &PresentedClientChange::WouldCreate
        );
    }

    /// A server-defined registration is fixed: its ceiling is itself, so a
    /// request beyond it may grant nothing outside it.
    #[test]
    fn a_server_defined_registration_is_fixed() {
        let fixed = Client {
            registration_source: crate::domain::client::RegistrationSource::ServerDefined,
            ..client("app", &["read"])
        };
        let resolved = resolve(Some(&fixed), &["read", "write"]);
        assert_eq!(resolved.client_name(), "app display name");
        assert!(resolved.is_registration_fixed());
        assert!(resolved.is_redirect_registered());
        assert!(!resolved.are_scopes_registered());
        assert_eq!(
            resolved
                .approvable_scopes()
                .grantable_subset(vec!["read".to_owned(), "write".to_owned()]),
            ["read"]
        );
    }

    /// A disabled client says so; nothing else about the resolution changes.
    #[test]
    fn a_disabled_client_resolves_disabled() {
        let disabled = Client {
            disabled_at: Some(chrono::Utc::now()),
            ..client("app", &["read"])
        };
        let resolved = resolve(Some(&disabled), &["read"]);
        assert!(resolved.is_client_disabled());
        assert!(resolved.are_scopes_registered());
        assert_eq!(
            resolved.presented_client_change(),
            &PresentedClientChange::NoChange
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

        /// The change is exactly one of the three, and each is decided by the
        /// two facts it reports: `NoChange` iff the redirect is allowlisted and
        /// nothing is uncovered, and a `WouldWiden` change never carries both
        /// "nothing new" flags (that would be `NoChange`). The reported
        /// `unregistered_requested_scopes` are always a subset of what was requested, in request
        /// order.
        #[test]
        fn the_change_agrees_with_what_it_reports(
            registered in prop::collection::vec(arb_plain_scope(), 0..5),
            requested in prop::collection::vec(arb_plain_scope(), 0..5),
            allowlisted in any::<bool>(),
        ) {
            let mut app = client("app", &[]);
            app.allowed_scopes = registered;
            if !allowlisted {
                app.redirect_uris = Vec::new();
            }
            let change = PresentedClientChange::from_presented_registration(&PresentedClientRegistration {
                maybe_existing_client: Some(&app),
                redirect_uri: &redirect(),
                scopes: &requested,
            });
            let uncovered = uncovered_scopes(&app.allowed_scopes, &requested);
            match change {
                PresentedClientChange::WouldCreate => prop_assert!(false, "a known client never WouldCreate"),
                PresentedClientChange::NoChange => {
                    prop_assert!(allowlisted);
                    prop_assert!(uncovered.is_empty());
                }
                PresentedClientChange::WouldWiden { redirect_uri_is_new, unregistered_requested_scopes } => {
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
        /// `NoChange` — the property the fast path relies on.
        #[test]
        fn unioning_the_requested_scopes_makes_the_next_request_change_nothing(
            registered in prop::collection::vec(arb_plain_scope(), 0..5),
            requested in prop::collection::vec(arb_plain_scope(), 0..5),
        ) {
            let mut app = client("app", &[]);
            app.allowed_scopes = registered;
            app.allowed_scopes.extend(requested.iter().cloned());
            prop_assert_eq!(
                PresentedClientChange::from_presented_registration(&PresentedClientRegistration {
                    maybe_existing_client: Some(&app),
                    redirect_uri: &redirect(),
                    scopes: &requested,
                }),
                PresentedClientChange::NoChange,
            );
        }
    }
}
