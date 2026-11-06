//! Client capabilities — the `wildflower/Client.*` capabilities behind
//! `/authorization/clients[/{clientId}]`: list every registered client, and
//! set one's `disabled_at` or its refresh policy. What disabling does (and
//! leaves alone) and what a refresh policy limits are described under
//! "Client" in `slices/authorization/docs/Jargon Explanation.md`.

use chrono::{DateTime, Utc};

use wildflowerhealthio_scopes::{Permission, Scope, WildflowerResource};

use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::client::{Client, RefreshPolicy};
use crate::domain::essential_client::is_essential_client;
use crate::domain::grant_store::ClientsTx as _;
use crate::domain::GrantStore;

/// The scope gating [`ClientsReader`] — `wildflower/Client.r`. Shared by the
/// capability's `FixedScopeCapability` binding and
/// [`grantable_admin_scopes`](super::grantable_admin_scopes) so enforced and
/// grantable can't drift.
pub(crate) fn clients_reader_scopes() -> Vec<Scope> {
    vec![Scope::wildflower(
        WildflowerResource::Client,
        Permission::READ,
    )]
}

/// The scope gating [`ClientsUpdater`] — `wildflower/Client.u`: disabling,
/// re-enabling and changing the refresh policy edit the client row in place.
pub(crate) fn clients_updater_scopes() -> Vec<Scope> {
    vec![Scope::wildflower(
        WildflowerResource::Client,
        Permission::UPDATE,
    )]
}

/// A registered client as the Owner's "Trusted apps" list shows it — the stored
/// row plus whether it is essential (see [`is_essential_client`]), which
/// can't be disabled, so the UI offers no switch for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ClientView {
    /// The client's stored registration, disabled or not.
    pub(crate) client: Client,
    /// Whether the client is essential: the host app's own client or the
    /// browser-session client, without which the Owner has no way in. An
    /// essential client can't be disabled.
    pub(crate) essential: bool,
}

/// Read access to registered clients — `GET /authorization/clients`.
pub(crate) struct ClientsReader<S: GrantStore> {
    /// The store the clients are read from.
    store: S,
}

impl<S: GrantStore> ClientsReader<S> {
    /// Build the reader over a store handle lifted from the state.
    pub(crate) fn new(store: S) -> Self {
        ClientsReader { store }
    }

    /// Every registered client, ordered by `client_id`, disabled ones included,
    /// each marked essential or not.
    pub(crate) fn list(&self) -> Result<Vec<ClientView>, AuthorizationServerError> {
        Ok(self
            .store
            .read(|tx| tx.list_clients())?
            .into_iter()
            .map(|client| ClientView {
                essential: is_essential_client(&client.client_id),
                client,
            })
            .collect())
    }
}

/// Edit a registered client — `PATCH /authorization/clients/{clientId}`:
/// disable or re-enable it by writing its `disabled_at`, or replace its
/// refresh policy. Idempotent: repeating a request leaves the row as the
/// first one left it (a repeated disable keeps the original `disabled_at`).
pub(crate) struct ClientsUpdater<S: GrantStore> {
    /// The store holding the client rows the updater edits.
    store: S,
}

impl<S: GrantStore> ClientsUpdater<S> {
    /// Build the updater over a store handle lifted from the state.
    pub(crate) fn new(store: S) -> Self {
        ClientsUpdater { store }
    }

    /// Set `client_id`'s `disabled_at` in one write scope and return the row as
    /// stored.
    ///
    /// - `Some(stamp)` disables the client, stamped `stamp`. The handler passes
    ///   the server's own now whatever time was sent, so a disable can't be
    ///   scheduled or backdated. A client that already carries a stamp keeps
    ///   it, so a repeated disable doesn't move the time, and a write that
    ///   would change nothing is skipped.
    /// - `None` re-enables the client. Its registration (redirects, scopes,
    ///   secret) is untouched by the round trip.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::ClientNotFound`] when no such client exists.
    /// Disabling an essential client is
    /// [`AuthorizationServerError::EssentialClient`] (see
    /// [`is_essential_client`]), refused before anything is read. Re-enabling
    /// one stays allowed, so an essential client disabled out of band (direct
    /// SQL) can still be recovered.
    pub(crate) fn set_disabled_at(
        &self,
        client_id: &str,
        stamp: Option<DateTime<Utc>>,
    ) -> Result<ClientView, AuthorizationServerError> {
        let essential = is_essential_client(client_id);
        if essential && stamp.is_some() {
            return Err(AuthorizationServerError::EssentialClient {
                client_id: client_id.to_owned(),
            });
        }
        let not_found = || AuthorizationServerError::ClientNotFound {
            client_id: client_id.to_owned(),
        };
        // One write scope, so two concurrent disables serialise at the read
        // and the second sees (and keeps) the first one's stamp.
        let client = self.store.write(|tx| {
            let client = tx.client_by_id(client_id)?.ok_or_else(not_found)?;
            let disabled_at = stamp.map(|stamp| client.disabled_at.unwrap_or(stamp));
            if disabled_at == client.disabled_at {
                return Ok(client);
            }
            if tx.set_client_disabled(client_id, disabled_at)? {
                Ok(Client {
                    disabled_at,
                    ..client
                })
            } else {
                Err(not_found())
            }
        })?;
        Ok(ClientView { client, essential })
    }

    /// Replace `client_id`'s refresh policy in one write scope and return the
    /// row as stored. Its families pick the policy up on their next refresh:
    /// a tighter one refuses a family that is past it, and a looser one moves
    /// a family's deadline out when it next rotates, but never revives a
    /// family that already ended. An essential client's policy may be
    /// changed like any other.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::ClientNotFound`] when no such client exists.
    pub(crate) fn set_refresh_policy(
        &self,
        client_id: &str,
        refresh_policy: RefreshPolicy,
    ) -> Result<ClientView, AuthorizationServerError> {
        let not_found = || AuthorizationServerError::ClientNotFound {
            client_id: client_id.to_owned(),
        };
        let client = self.store.write(|tx| {
            if !tx.set_client_refresh_policy(client_id, &refresh_policy)? {
                return Err(not_found());
            }
            tx.client_by_id(client_id)?.ok_or_else(not_found)
        })?;
        Ok(ClientView {
            client,
            essential: is_essential_client(client_id),
        })
    }
}

#[cfg(test)]
mod tests {
    use crate::domain::grant_store::*;
    use proptest::prelude::*;

    use super::*;
    use crate::domain::test_fake::{client, FakeGrantStore};

    /// The host app's own client id, one of the two essential clients.
    const HOST: &str = crate::WILDFLOWER_HOST_APP_CLIENT_ID;
    /// The browser-session client id, the other essential client.
    const BROWSER_SESSION_CLIENT: &str = crate::BROWSER_SESSION_CLIENT_ID;

    /// A updater over a fresh fake seeded with `rows`; tests reach the fake
    /// through its `store` field to arrange and observe rows.
    fn updater_with(rows: &[Client]) -> ClientsUpdater<FakeGrantStore> {
        let store = FakeGrantStore::default();
        for row in rows {
            store.tx().upsert_client(row).unwrap();
        }
        ClientsUpdater::new(store)
    }

    /// The instant `seconds` after the Unix epoch.
    fn at(seconds: i64) -> DateTime<Utc> {
        DateTime::from_timestamp(seconds, 0).expect("in-range timestamp")
    }

    /// The `client_id` row as the updater's store holds it.
    fn stored(updater: &ClientsUpdater<FakeGrantStore>, client_id: &str) -> Client {
        updater
            .store
            .tx()
            .client_by_id(client_id)
            .unwrap()
            .expect("client row present")
    }

    /// The stamp every disable in these tests writes, unless a test says
    /// otherwise.
    const NOW: i64 = 5_000;

    /// Disable `client_id`, stamped `stamp` seconds after the epoch.
    fn disable(
        updater: &ClientsUpdater<FakeGrantStore>,
        client_id: &str,
        stamp: i64,
    ) -> Result<ClientView, AuthorizationServerError> {
        updater.set_disabled_at(client_id, Some(at(stamp)))
    }

    /// Re-enable `client_id`.
    fn enable(
        updater: &ClientsUpdater<FakeGrantStore>,
        client_id: &str,
    ) -> Result<ClientView, AuthorizationServerError> {
        updater.set_disabled_at(client_id, None)
    }

    /// The list returns every client in `client_id` order and marks only the
    /// host app and the browser-session client essential.
    #[test]
    fn list_flags_only_the_essential_clients() {
        let store = FakeGrantStore::default();
        for id in ["b-app", HOST, BROWSER_SESSION_CLIENT, "a-app"] {
            store.tx().upsert_client(&client(id, &["openid"])).unwrap();
        }

        let listed = ClientsReader::new(store).list().unwrap();
        let summary: Vec<(&str, bool)> = listed
            .iter()
            .map(|view| (view.client.client_id.as_str(), view.essential))
            .collect();
        assert_eq!(
            summary,
            vec![
                ("a-app", false),
                ("b-app", false),
                (HOST, true),
                (BROWSER_SESSION_CLIENT, true)
            ]
        );
    }

    /// Disabling stamps only `disabled_at`, enabling clears it, and each call
    /// returns the row exactly as stored.
    #[test]
    fn disable_then_enable_stamps_and_clears_only_disabled_at() {
        let registered = client("app", &["openid", "patient/*.rs"]);
        let updater = updater_with(std::slice::from_ref(&registered));
        let disabled = Client {
            disabled_at: Some(at(NOW)),
            ..registered.clone()
        };

        assert_eq!(
            disable(&updater, "app", NOW),
            Ok(ClientView {
                client: disabled.clone(),
                essential: false
            })
        );
        assert_eq!(stored(&updater, "app"), disabled);

        assert_eq!(
            enable(&updater, "app"),
            Ok(ClientView {
                client: registered.clone(),
                essential: false
            })
        );
        assert_eq!(stored(&updater, "app"), registered);
    }

    /// A second disable, a second later, leaves the first stamp in both the
    /// answer and the row.
    #[test]
    fn a_repeated_disable_keeps_the_first_timestamp() {
        let updater = updater_with(&[client("app", &["openid"])]);
        disable(&updater, "app", NOW).unwrap();
        let repeated = disable(&updater, "app", NOW + 1);
        assert_eq!(repeated.unwrap().client.disabled_at, Some(at(NOW)));
        assert_eq!(stored(&updater, "app").disabled_at, Some(at(NOW)));
    }

    /// Enabling a client that is not disabled leaves its row as registered.
    #[test]
    fn enabling_an_enabled_client_is_a_no_op() {
        let registered = client("app", &["openid"]);
        let updater = updater_with(std::slice::from_ref(&registered));
        enable(&updater, "app").unwrap();
        assert_eq!(stored(&updater, "app"), registered);
    }

    /// Disabling and enabling an unregistered client are both
    /// `ClientNotFound`, and neither creates a row.
    #[test]
    fn an_unknown_client_is_client_not_found_either_way() {
        let updater = updater_with(&[]);
        let not_found = Err(AuthorizationServerError::ClientNotFound {
            client_id: "ghost".to_owned(),
        });
        assert_eq!(disable(&updater, "ghost", NOW), not_found);
        assert_eq!(enable(&updater, "ghost"), not_found);
        assert!(
            updater.store.tx().list_clients().unwrap().is_empty(),
            "nothing created"
        );
    }

    /// For each essential client, a disable is `EssentialClient` and writes
    /// nothing; an enable succeeds and reports it essential.
    #[test]
    fn an_essential_client_cannot_be_disabled_but_can_be_enabled() {
        for essential_client_id in [HOST, BROWSER_SESSION_CLIENT] {
            let essential_client = client(essential_client_id, &["openid"]);
            let updater = updater_with(std::slice::from_ref(&essential_client));

            assert_eq!(
                disable(&updater, essential_client_id, NOW),
                Err(AuthorizationServerError::EssentialClient {
                    client_id: essential_client_id.to_owned()
                }),
            );
            assert_eq!(
                stored(&updater, essential_client_id),
                essential_client,
                "nothing written"
            );
            // Enabling it stays allowed — an essential client disabled out of
            // band (direct SQL) can still be recovered.
            assert_eq!(
                enable(&updater, essential_client_id),
                Ok(ClientView {
                    client: essential_client,
                    essential: true
                })
            );
        }
    }

    /// Two registered clients and one id (`ghost`) that is never registered.
    const IDS: [&str; 3] = ["app-a", "app-b", "ghost"];

    proptest! {
        /// Any sequence of disables and enables — each step an index into
        /// `IDS` and the stamp to disable with (`None` enables) — leaves each
        /// client's `disabled_at` equal to a simple model: the stamp of the
        /// first disable since the last enable, or `None`. No step touches any
        /// other field or creates a row. Each step returns the row as stored;
        /// every step naming the unregistered id is `ClientNotFound`.
        #[test]
        fn disable_and_enable_match_the_model(
            steps in prop::collection::vec(
                (0..IDS.len(), prop::option::of(0..10_000i64)),
                0..24,
            ),
        ) {
            let registered = [client(IDS[0], &["openid"]), client(IDS[1], &["patient/*.rs"])];
            let updater = updater_with(&registered);
            let mut model: [Option<DateTime<Utc>>; 2] = [None, None];

            for (index, stamp) in steps {
                if let Some(slot) = model.get_mut(index) {
                    *slot = stamp.map(|stamp| slot.unwrap_or(at(stamp)));
                }
                let result = updater.set_disabled_at(IDS[index], stamp.map(at));
                match (registered.get(index), model.get(index)) {
                    (Some(row), Some(&disabled_at)) => {
                        let expected = ClientView {
                            client: Client { disabled_at, ..row.clone() },
                            essential: false,
                        };
                        prop_assert_eq!(result, Ok(expected));
                    }
                    _ => {
                        let not_found = AuthorizationServerError::ClientNotFound { client_id: IDS[index].to_owned() };
                        prop_assert_eq!(result, Err(not_found));
                    }
                }
            }

            for (row, disabled_at) in registered.iter().zip(model) {
                prop_assert_eq!(stored(&updater, &row.client_id), Client { disabled_at, ..row.clone() });
            }
            prop_assert_eq!(updater.store.tx().list_clients().unwrap().len(), registered.len());
        }
    }

    /// Setting a refresh policy replaces only the policy, an essential
    /// client's included, and answers with the row as stored; an unknown
    /// client is `ClientNotFound` and gets no row.
    #[test]
    fn set_refresh_policy_replaces_only_the_policy() {
        use chrono::Duration;

        let registered = client("app", &["openid"]);
        let essential_client = client(HOST, &["openid"]);
        let updater = updater_with(&[registered.clone(), essential_client.clone()]);
        let refresh_policy = RefreshPolicy {
            idle_ttl: Some(Duration::minutes(30)),
            max_ttl: Some(Duration::days(1)),
            ends_with_browser_session: true,
        };

        for (row, essential) in [(registered, false), (essential_client, true)] {
            let changed = Client {
                refresh_policy,
                ..row.clone()
            };
            assert_eq!(
                updater.set_refresh_policy(&row.client_id, refresh_policy),
                Ok(ClientView {
                    client: changed.clone(),
                    essential
                })
            );
            assert_eq!(stored(&updater, &row.client_id), changed);
        }
        assert_eq!(
            updater.set_refresh_policy("ghost", refresh_policy),
            Err(AuthorizationServerError::ClientNotFound {
                client_id: "ghost".to_owned()
            })
        );
        assert_eq!(updater.store.tx().list_clients().unwrap().len(), 2);
    }
}
