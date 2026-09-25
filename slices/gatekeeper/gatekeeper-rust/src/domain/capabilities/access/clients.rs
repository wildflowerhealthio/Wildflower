//! Client capabilities — the `wildflower/Client.*` capabilities behind
//! `/access/clients[/{clientId}]`: list every registered client and set one's
//! `disabled_at`. What disabling does (and leaves
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

/// Disable or re-enable a client by writing its `disabled_at` —
/// `PATCH /access/clients/{clientId}`. Idempotent: repeating a request leaves
/// the row as the first one left it (a repeated disable keeps the original
/// `disabled_at`).
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

    /// Set `client_id`'s `disabled_at` in one transaction and return the row as
    /// stored.
    ///
    /// - `Some(requested)` disables the client from `requested`, or from `now`
    ///   when `requested` is already past — the caller can schedule a disable
    ///   but can't backdate one. A client that already carries a stamp keeps
    ///   it, so a repeated disable doesn't move the time.
    /// - `None` re-enables the client (or cancels a scheduled disable). Its
    ///   registration (redirects, scopes, secret) is untouched by the round
    ///   trip.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::ClientNotFound`] when no such client exists.
    /// Disabling the first-party host is
    /// [`GatekeeperError::FirstPartyClientLocked`] — it would lock the Owner out
    /// of the very surface that re-enables it. Re-enabling it stays allowed, so
    /// a host disabled out of band (direct SQL) can still be recovered.
    pub(crate) fn set_disabled_at(
        &self,
        client_id: &str,
        requested: Option<DateTime<Utc>>,
        now: DateTime<Utc>,
    ) -> Result<ClientView, GatekeeperError> {
        let first_party = client_id == &*self.first_party_client_id;
        if first_party && requested.is_some() {
            return Err(GatekeeperError::FirstPartyClientLocked {
                client_id: client_id.to_owned(),
            });
        }
        let not_found = || GatekeeperError::ClientNotFound {
            client_id: client_id.to_owned(),
        };
        // Immediate, so two concurrent disables serialise at the read and the
        // second sees (and keeps) the first one's stamp.
        let client = self.store.immediate_transaction(|tx| {
            let client = tx.client_by_id(client_id)?.ok_or_else(not_found)?;
            let disabled_at =
                requested.map(|requested| client.disabled_at.unwrap_or(requested.max(now)));
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
        Ok(ClientView {
            client,
            first_party,
        })
    }
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

    /// The instant every request in these tests is handled at, unless a test
    /// says otherwise.
    const NOW: i64 = 5_000;

    fn disable(
        disabler: &ClientsDisabler<FakeGatekeeperStore>,
        client_id: &str,
        requested: i64,
    ) -> Result<ClientView, GatekeeperError> {
        disabler.set_disabled_at(client_id, Some(at(requested)), at(NOW))
    }

    fn enable(
        disabler: &ClientsDisabler<FakeGatekeeperStore>,
        client_id: &str,
    ) -> Result<ClientView, GatekeeperError> {
        disabler.set_disabled_at(client_id, None, at(NOW))
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

    /// Disabling stamps only `disabled_at`, enabling clears it, and each call
    /// returns the row exactly as stored.
    #[test]
    fn disable_then_enable_stamps_and_clears_only_disabled_at() {
        let registered = client("app", &["openid", "patient/*.rs"]);
        let disabler = disabler_with(std::slice::from_ref(&registered));
        let disabled = Client {
            disabled_at: Some(at(NOW)),
            ..registered.clone()
        };

        assert_eq!(
            disable(&disabler, "app", NOW),
            Ok(ClientView {
                client: disabled.clone(),
                first_party: false
            })
        );
        assert_eq!(stored(&disabler, "app"), disabled);

        assert_eq!(
            enable(&disabler, "app"),
            Ok(ClientView {
                client: registered.clone(),
                first_party: false
            })
        );
        assert_eq!(stored(&disabler, "app"), registered);
    }

    /// A requested time already past is replaced by the server's `now`; a
    /// future one is kept as a scheduled disable.
    #[test]
    fn a_past_request_is_clamped_to_now_and_a_future_one_is_scheduled() {
        let disabler = disabler_with(&[client("past", &["openid"]), client("later", &["openid"])]);
        disable(&disabler, "past", NOW - 1_000).unwrap();
        disable(&disabler, "later", NOW + 1_000).unwrap();
        assert_eq!(stored(&disabler, "past").disabled_at, Some(at(NOW)));
        assert_eq!(
            stored(&disabler, "later").disabled_at,
            Some(at(NOW + 1_000))
        );
    }

    #[test]
    fn a_repeated_disable_keeps_the_first_timestamp() {
        let disabler = disabler_with(&[client("app", &["openid"])]);
        disable(&disabler, "app", NOW).unwrap();
        let repeated = disabler.set_disabled_at("app", Some(at(NOW + 1)), at(NOW + 1));
        assert_eq!(repeated.unwrap().client.disabled_at, Some(at(NOW)));
        assert_eq!(stored(&disabler, "app").disabled_at, Some(at(NOW)));
    }

    #[test]
    fn enabling_an_enabled_client_is_a_no_op() {
        let registered = client("app", &["openid"]);
        let disabler = disabler_with(std::slice::from_ref(&registered));
        enable(&disabler, "app").unwrap();
        assert_eq!(stored(&disabler, "app"), registered);
    }

    #[test]
    fn an_unknown_client_is_client_not_found_either_way() {
        let disabler = disabler_with(&[]);
        let not_found = Err(GatekeeperError::ClientNotFound {
            client_id: "ghost".to_owned(),
        });
        assert_eq!(disable(&disabler, "ghost", NOW), not_found);
        assert_eq!(enable(&disabler, "ghost"), not_found);
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
            disable(&disabler, HOST, NOW),
            Err(GatekeeperError::FirstPartyClientLocked {
                client_id: HOST.to_owned()
            }),
        );
        assert_eq!(stored(&disabler, HOST), host, "nothing written");
        // Enabling it stays allowed — a host disabled out of band (direct SQL)
        // can still be recovered.
        assert_eq!(
            enable(&disabler, HOST),
            Ok(ClientView {
                client: host,
                first_party: true
            })
        );
    }

    /// One disable/enable step against the model; `client` indexes `IDS`, and
    /// `tick` is how far the clock moves before the step is handled.
    #[derive(Debug, Clone)]
    enum Step {
        Disable {
            client: usize,
            requested: i64,
            tick: i64,
        },
        Enable {
            client: usize,
            tick: i64,
        },
    }

    /// Two registered clients and one id (`ghost`) that is never registered.
    const IDS: [&str; 3] = ["app-a", "app-b", "ghost"];

    fn arb_step() -> impl Strategy<Value = Step> {
        prop_oneof![
            (0..IDS.len(), 0..10_000i64, 0..500i64).prop_map(|(client, requested, tick)| {
                Step::Disable {
                    client,
                    requested,
                    tick,
                }
            }),
            (0..IDS.len(), 0..500i64).prop_map(|(client, tick)| Step::Enable { client, tick }),
        ]
    }

    proptest! {
        /// Any sequence of disables and enables, handled on an advancing clock,
        /// leaves each client's `disabled_at` equal to a simple model — the
        /// effective time (`max(requested, now)`) of the first disable since the
        /// last enable, or `None` — and never touches any other field or
        /// creates a row. Each step returns the row as stored; every step naming
        /// the unregistered id is `ClientNotFound`.
        #[test]
        fn disable_and_enable_match_the_model(steps in prop::collection::vec(arb_step(), 0..24)) {
            let registered = [client(IDS[0], &["openid"]), client(IDS[1], &["patient/*.rs"])];
            let disabler = disabler_with(&registered);
            let mut model: [Option<DateTime<Utc>>; 2] = [None, None];
            let mut now = 0;

            for step in steps {
                let (index, requested) = match step {
                    Step::Disable { client, requested, tick } => {
                        now += tick;
                        (client, Some(requested))
                    }
                    Step::Enable { client, tick } => {
                        now += tick;
                        (client, None)
                    }
                };
                if let Some(slot) = model.get_mut(index) {
                    *slot = requested.map(|requested| slot.unwrap_or(at(requested.max(now))));
                }
                let result = disabler.set_disabled_at(IDS[index], requested.map(at), at(now));
                match (registered.get(index), model.get(index)) {
                    (Some(row), Some(&disabled_at)) => {
                        let expected = ClientView {
                            client: Client { disabled_at, ..row.clone() },
                            first_party: false,
                        };
                        prop_assert_eq!(result, Ok(expected));
                    }
                    _ => {
                        let not_found = GatekeeperError::ClientNotFound { client_id: IDS[index].to_owned() };
                        prop_assert_eq!(result, Err(not_found));
                    }
                }
            }

            for (row, disabled_at) in registered.iter().zip(model) {
                prop_assert_eq!(stored(&disabler, &row.client_id), Client { disabled_at, ..row.clone() });
            }
            prop_assert_eq!(disabler.store.list_clients().unwrap().len(), registered.len());
        }
    }
}
