//! [`ClientScopesReader`] — the scopes an OAuth client is permitted to
//! request, for the host's per-app SMART launch check (the apps slice resolves
//! a SMART app's `client_id` to this set through its `AppLaunchScopes` port).

use scopes_rust::Scope;

use crate::domain::gatekeeper_error::GatekeeperError;
use crate::domain::GatekeeperStore;

/// Read a client's `allowed_scopes`. Generic over the store port; the binding
/// instantiates it over the concrete `SqliteGatekeeperStore`.
pub(crate) struct ClientScopesReader<S: GatekeeperStore> {
    store: S,
}

impl<S: GatekeeperStore> ClientScopesReader<S> {
    /// Build the reader over a store handle lifted from the state.
    pub(crate) fn new(store: S) -> Self {
        ClientScopesReader { store }
    }

    /// The parsed `allowed_scopes` of `client_id`. An unknown `client_id` (a
    /// SMART app registration whose client row was deleted or misconfigured)
    /// yields an empty set — the per-app launch check then gates on the
    /// `wildflower/launch` umbrella alone — and is logged as a warning so the
    /// fail-open scope downgrade is detectable rather than silent.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] on a store failure.
    pub(crate) fn allowed_scopes(&self, client_id: &str) -> Result<Vec<Scope>, GatekeeperError> {
        let Some(client) = self.store.client_by_id(client_id)? else {
            tracing::warn!(
                "app launch scopes requested for unknown client_id `{client_id}`; per-app \
                 SMART scope check falls open to the `wildflower/launch` umbrella only",
            );
            return Ok(Vec::new());
        };
        Ok(client
            .allowed_scopes
            .iter()
            .map(|scope| Scope::from(scope.as_str()))
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::test_fake::{client, FakeGatekeeperStore};

    /// A registered client's allowlist comes back parsed; an unknown client is
    /// the empty (fail-open, logged) set.
    #[test]
    fn allowed_scopes_are_parsed_and_unknown_clients_are_empty() {
        let store = FakeGatekeeperStore::default();
        store
            .upsert_client(&client("app", &["patient/*.rs", "openid"]))
            .unwrap();
        let reader = ClientScopesReader::new(store);
        assert_eq!(
            scopes_rust::render_scopes(&reader.allowed_scopes("app").unwrap()),
            vec!["patient/*.rs".to_owned(), "openid".to_owned()]
        );
        assert!(reader.allowed_scopes("ghost").unwrap().is_empty());
    }
}
