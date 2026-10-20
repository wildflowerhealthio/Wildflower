//! An authorization-code request **resolved against its client's
//! registration** as it stands now: [`ResolvedCodeRequest`], the one place
//! `/oauth/authorize`, the limited page's Continue, and the consent read and
//! approval learn what the [`clients`](crate::domain::client::Client) row says
//! about a request — its client's name, whether the client is disabled, the
//! [presented client change](crate::domain::client::presented_change::PresentedClientChange),
//! and the scopes an approval may grant.
//!
//! The resolution is **derived, never stored**: it is recomputed from the
//! current row on every read, so a prompt loaded after the row moved reflects
//! the move.

use url::Url;

use crate::domain::authority::ApprovableScopes;
use crate::domain::client::presented_change::{PresentedClientChange, PresentedClientRegistration};
use crate::domain::client::Client;

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
        match maybe_existing_client {
            // Trusted on first use: an unknown client is named by its
            // `client_id`, and approving its request would create its row.
            None => ResolvedCodeRequest {
                client_name: client_id.to_owned(),
                client_disabled: false,
                registration_is_fixed: false,
                redirect_is_registered: false,
                presented_client_change: PresentedClientChange::WouldCreate,
                approvable_scopes: ApprovableScopes::for_code(requested_scopes, None, false),
            },
            Some(existing_client) => {
                let registration_is_fixed = existing_client.is_registration_fixed();
                ResolvedCodeRequest {
                    client_name: existing_client.name.clone(),
                    client_disabled: existing_client.disabled_at.is_some(),
                    registration_is_fixed,
                    redirect_is_registered: existing_client.allows_redirect_uri(redirect_uri),
                    presented_client_change: PresentedClientChange::from_presented_registration(
                        &PresentedClientRegistration {
                            maybe_existing_client: Some(existing_client),
                            redirect_uri,
                            scopes: requested_scopes,
                        },
                    ),
                    approvable_scopes: ApprovableScopes::for_code(
                        requested_scopes,
                        Some(existing_client),
                        registration_is_fixed,
                    ),
                }
            }
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
    use crate::domain::client::RegistrationSource;
    use crate::domain::test_fake::client;

    fn redirect() -> Url {
        Url::parse("https://example.com/cb").expect("a valid redirect")
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
            registration_source: RegistrationSource::ServerDefined,
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
}
