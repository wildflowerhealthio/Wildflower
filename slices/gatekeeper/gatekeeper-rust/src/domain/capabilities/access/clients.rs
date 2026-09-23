//! Client capabilities — the `wildflower/Client.*` capabilities behind
//! `/access/clients[/{clientId}/{disable,enable}]`: list every registered
//! client and switch one's `disabled_at`. What disabling does (and leaves
//! alone) is described under "Client" in `slices/gatekeeper/docs/Jargon
//! Explanation.md`.

use std::sync::Arc;

use chrono::{DateTime, Utc};

use scopes_rust::{Permission, Scope, WildflowerResource};

use crate::domain::client::Client;
use crate::domain::gatekeeper_error::GatekeeperError;
use crate::domain::{GatekeeperStore, GatekeeperTx};

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

/// The scope gating [`ClientsDisabler`] — `wildflower/Client.u`: disabling and
/// re-enabling edit the client row's `disabled_at` in place.
pub(crate) fn clients_disabler_scopes() -> Vec<Scope> {
    vec![Scope::wildflower(
        WildflowerResource::Client,
        Permission::UPDATE,
    )]
}

/// A registered client as the Owner's "Trusted apps" list shows it — the stored
/// row plus whether it is the first-party host (which can't be disabled, so the
/// UI offers no switch for it).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ClientView {
    pub(crate) client: Client,
    pub(crate) first_party: bool,
}

/// Read access to registered clients — `GET /access/clients`.
pub(crate) struct ClientsReader<S: GatekeeperStore> {
    store: S,
    first_party_client_id: Arc<str>,
}

impl<S: GatekeeperStore> ClientsReader<S> {
    /// Build the reader over a store handle and the configured first-party
    /// `client_id`, both lifted from the state.
    pub(crate) fn new(store: S, first_party_client_id: Arc<str>) -> Self {
        ClientsReader {
            store,
            first_party_client_id,
        }
    }

    /// Every registered client, ordered by `client_id`, disabled ones included.
    pub(crate) fn list(&self) -> Result<Vec<ClientView>, GatekeeperError> {
        Ok(self
            .store
            .list_clients()?
            .into_iter()
            .map(|client| ClientView {
                first_party: client.client_id == *self.first_party_client_id,
                client,
            })
            .collect())
    }
}

/// Disable or re-enable a client — `POST /access/clients/{clientId}/{disable,enable}`.
/// Both are idempotent: repeating one leaves the row as the first call left it
/// (a repeated disable keeps the original `disabled_at`).
pub(crate) struct ClientsDisabler<S: GatekeeperStore> {
    store: S,
    first_party_client_id: Arc<str>,
}

impl<S: GatekeeperStore> ClientsDisabler<S> {
    /// Build the disabler over a store handle and the configured first-party
    /// `client_id`, both lifted from the state.
    pub(crate) fn new(store: S, first_party_client_id: Arc<str>) -> Self {
        ClientsDisabler {
            store,
            first_party_client_id,
        }
    }

    /// Disable `client_id` as of `now`, or [`GatekeeperError::ClientNotFound`]
    /// when no such client exists. The first-party host is refused with
    /// [`GatekeeperError::FirstPartyClientLocked`] — disabling it would lock the
    /// Owner out of the very surface that re-enables it.
    pub(crate) fn disable(
        &self,
        client_id: &str,
        now: DateTime<Utc>,
    ) -> Result<(), GatekeeperError> {
        if client_id == &*self.first_party_client_id {
            return Err(GatekeeperError::FirstPartyClientLocked {
                client_id: client_id.to_owned(),
            });
        }
        set_disabled(&self.store, client_id, Some(now))
    }

    /// Re-enable `client_id`, or [`GatekeeperError::ClientNotFound`] when no such
    /// client exists. Its registration (redirects, scopes, secret) is untouched
    /// by the disable → enable round trip.
    pub(crate) fn enable(&self, client_id: &str) -> Result<(), GatekeeperError> {
        set_disabled(&self.store, client_id, None)
    }
}

/// Move `client_id` to the wanted disabled state in one transaction: a missing
/// row is [`GatekeeperError::ClientNotFound`]; a row already in that state
/// (disabled or not) is left alone, so a repeated disable keeps its first
/// timestamp.
fn set_disabled(
    store: &impl GatekeeperStore,
    client_id: &str,
    disabled_at: Option<DateTime<Utc>>,
) -> Result<(), GatekeeperError> {
    let not_found = || GatekeeperError::ClientNotFound {
        client_id: client_id.to_owned(),
    };
    store.transaction(|tx| {
        let client = tx.client_by_id(client_id)?.ok_or_else(not_found)?;
        if client.disabled_at.is_some() == disabled_at.is_some() {
            return Ok(());
        }
        if tx.set_client_disabled(client_id, disabled_at)? {
            Ok(())
        } else {
            Err(not_found())
        }
    })
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    use super::*;
    use crate::domain::test_fake::{client, FakeGatekeeperStore};

    const HOST: &str = "wildflower-host";

    /// A disabler over a fresh fake seeded with `rows`; tests reach the fake
    /// through its `store` field to arrange and observe rows.
    fn disabler_with(rows: &[Client]) -> ClientsDisabler<FakeGatekeeperStore> {
        let store = FakeGatekeeperStore::default();
        for row in rows {
            store.upsert_client(row).unwrap();
        }
        ClientsDisabler::new(store, Arc::from(HOST))
    }

    fn at(seconds: i64) -> DateTime<Utc> {
        DateTime::from_timestamp(seconds, 0).expect("in-range timestamp")
    }

    fn stored(disabler: &ClientsDisabler<FakeGatekeeperStore>, client_id: &str) -> Client {
        disabler
            .store
            .client_by_id(client_id)
            .unwrap()
            .expect("client row present")
    }

    #[test]
    fn list_flags_only_the_first_party_client() {
        let store = FakeGatekeeperStore::default();
        for id in ["b-app", HOST, "a-app"] {
            store.upsert_client(&client(id, &["openid"])).unwrap();
        }

        let listed = ClientsReader::new(store, Arc::from(HOST)).list().unwrap();
        let summary: Vec<(&str, bool)> = listed
            .iter()
            .map(|view| (view.client.client_id.as_str(), view.first_party))
            .collect();
        assert_eq!(
            summary,
            vec![("a-app", false), ("b-app", false), (HOST, true)]
        );
    }

    #[test]
    fn disable_then_enable_stamps_and_clears_only_disabled_at() {
        let registered = client("app", &["openid", "patient/*.rs"]);
        let disabler = disabler_with(std::slice::from_ref(&registered));

        disabler.disable("app", at(1_000)).unwrap();
        assert_eq!(
            stored(&disabler, "app"),
            Client {
                disabled_at: Some(at(1_000)),
                ..registered.clone()
            }
        );

        disabler.enable("app").unwrap();
        assert_eq!(stored(&disabler, "app"), registered);
    }

    #[test]
    fn a_repeated_disable_keeps_the_first_timestamp() {
        let disabler = disabler_with(&[client("app", &["openid"])]);
        disabler.disable("app", at(1_000)).unwrap();
        disabler.disable("app", at(2_000)).unwrap();
        assert_eq!(stored(&disabler, "app").disabled_at, Some(at(1_000)));
    }

    #[test]
    fn enabling_an_enabled_client_is_a_no_op() {
        let registered = client("app", &["openid"]);
        let disabler = disabler_with(std::slice::from_ref(&registered));
        disabler.enable("app").unwrap();
        assert_eq!(stored(&disabler, "app"), registered);
    }

    #[test]
    fn an_unknown_client_is_client_not_found_either_way() {
        let disabler = disabler_with(&[]);
        let not_found = Err(GatekeeperError::ClientNotFound {
            client_id: "ghost".to_owned(),
        });
        assert_eq!(disabler.disable("ghost", at(1_000)), not_found);
        assert_eq!(disabler.enable("ghost"), not_found);
        assert!(
            disabler.store.list_clients().unwrap().is_empty(),
            "nothing created"
        );
    }

    #[test]
    fn the_first_party_client_cannot_be_disabled() {
        let host = client(HOST, &["openid"]);
        let disabler = disabler_with(std::slice::from_ref(&host));

        assert_eq!(
            disabler.disable(HOST, at(1_000)),
            Err(GatekeeperError::FirstPartyClientLocked {
                client_id: HOST.to_owned()
            }),
        );
        assert_eq!(stored(&disabler, HOST), host, "nothing written");
        // Enabling it stays allowed — a host disabled out of band (direct SQL)
        // can still be recovered.
        assert_eq!(disabler.enable(HOST), Ok(()));
    }

    /// One disable/enable step against the model; `client` indexes `IDS`.
    #[derive(Debug, Clone)]
    enum Step {
        Disable { client: usize, at: i64 },
        Enable { client: usize },
    }

    /// Two registered clients and one id (`ghost`) that is never registered.
    const IDS: [&str; 3] = ["app-a", "app-b", "ghost"];

    fn arb_step() -> impl Strategy<Value = Step> {
        prop_oneof![
            (0..IDS.len(), 0..10_000i64).prop_map(|(client, at)| Step::Disable { client, at }),
            (0..IDS.len()).prop_map(|client| Step::Enable { client }),
        ]
    }

    proptest! {
        /// Any sequence of disables and enables leaves each client's
        /// `disabled_at` equal to a simple model — the timestamp of the first
        /// disable since the last enable, or `None` — and never touches any
        /// other field or creates a row. Every step naming the unregistered id
        /// is `ClientNotFound`; every other step succeeds.
        #[test]
        fn disable_and_enable_match_the_model(steps in prop::collection::vec(arb_step(), 0..24)) {
            let registered = [client(IDS[0], &["openid"]), client(IDS[1], &["patient/*.rs"])];
            let disabler = disabler_with(&registered);
            let mut model: [Option<DateTime<Utc>>; 2] = [None, None];

            for step in steps {
                let (index, result) = match step {
                    Step::Disable { client, at: seconds } => {
                        if let Some(slot) = model.get_mut(client) {
                            slot.get_or_insert(at(seconds));
                        }
                        (client, disabler.disable(IDS[client], at(seconds)))
                    }
                    Step::Enable { client } => {
                        if let Some(slot) = model.get_mut(client) {
                            *slot = None;
                        }
                        (client, disabler.enable(IDS[client]))
                    }
                };
                if index < registered.len() {
                    prop_assert_eq!(result, Ok(()));
                } else {
                    let not_found = GatekeeperError::ClientNotFound { client_id: IDS[index].to_owned() };
                    prop_assert_eq!(result, Err(not_found));
                }
            }

            for (row, disabled_at) in registered.iter().zip(model) {
                prop_assert_eq!(stored(&disabler, &row.client_id), Client { disabled_at, ..row.clone() });
            }
            prop_assert_eq!(disabler.store.list_clients().unwrap().len(), registered.len());
        }
    }
}
