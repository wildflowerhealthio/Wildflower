//! The in-memory [`FakeGatekeeperStore`] and the request/grant fixtures the
//! per-entity action tests share. Modelling the primitive port semantics with no
//! diesel and no database is enough to exercise the actions' semantic mapping (the
//! `*NotFound` decisions, the consent-loader validation, and now the composed
//! transaction scripts — grant upserts, the three-state consume, revoke). The
//! primitives live on [`FakeGatekeeperTx`] (the fake's [`GatekeeperTx`](crate::domain::GatekeeperTx)); the
//! [`GatekeeperStore`] seam hands one out and, for
//! [`transaction`](GatekeeperStore::transaction) /
//! [`immediate_transaction`](GatekeeperStore::immediate_transaction), snapshots
//! the maps up front and restores them if the closure returns `Err`, so a failed
//! composed action rolls back exactly as diesel would. The `SQLite` adapter's own
//! SQL-level coverage (and its real lock semantics) live in `crate::db`, so the
//! operations the semantic tests never reach are simple in-memory stand-ins
//! rather than faithful SQL replicas.

use std::cell::RefCell;
use std::collections::HashMap;

use crate::domain::authorization_code::AuthorizationCode;
use crate::domain::authorization_request::AuthorizationRequest;
use crate::domain::client::Client;
use crate::domain::gatekeeper_error::GatekeeperError;
use crate::domain::grant::{AuthorizationCodeGrant, DeviceGrant};
use crate::domain::refresh_token::{RefreshToken, RefreshTokenFamily};
use crate::domain::signing_key::SigningKey;
use crate::domain::GatekeeperStore;

mod fixtures;
mod tx;

pub(crate) use fixtures::{client, code_grant, code_request, device_request};

/// An in-memory [`GatekeeperStore`] modelling the primitive port semantics with
/// no diesel and no database — enough to exercise the actions' semantic mapping
/// and their composed transaction scripts.
#[derive(Default)]
pub(crate) struct FakeGatekeeperStore {
    clients: RefCell<HashMap<String, Client>>,
    signing_keys: RefCell<Vec<SigningKey>>,
    authorization_requests: RefCell<HashMap<String, AuthorizationRequest>>,
    authorization_codes: RefCell<HashMap<String, AuthorizationCode>>,
    families: RefCell<HashMap<String, RefreshTokenFamily>>,
    tokens: RefCell<HashMap<String, RefreshToken>>,
    code_grants: RefCell<HashMap<String, AuthorizationCodeGrant>>,
    device_grants: RefCell<HashMap<String, DeviceGrant>>,
}

/// A clone of every map, taken before a transaction runs so it can be restored
/// on rollback.
struct Snapshot {
    clients: HashMap<String, Client>,
    signing_keys: Vec<SigningKey>,
    authorization_requests: HashMap<String, AuthorizationRequest>,
    authorization_codes: HashMap<String, AuthorizationCode>,
    families: HashMap<String, RefreshTokenFamily>,
    tokens: HashMap<String, RefreshToken>,
    code_grants: HashMap<String, AuthorizationCodeGrant>,
    device_grants: HashMap<String, DeviceGrant>,
}

impl FakeGatekeeperStore {
    fn snapshot(&self) -> Snapshot {
        Snapshot {
            clients: self.clients.borrow().clone(),
            signing_keys: self.signing_keys.borrow().clone(),
            authorization_requests: self.authorization_requests.borrow().clone(),
            authorization_codes: self.authorization_codes.borrow().clone(),
            families: self.families.borrow().clone(),
            tokens: self.tokens.borrow().clone(),
            code_grants: self.code_grants.borrow().clone(),
            device_grants: self.device_grants.borrow().clone(),
        }
    }

    fn restore(&self, snapshot: Snapshot) {
        *self.clients.borrow_mut() = snapshot.clients;
        *self.signing_keys.borrow_mut() = snapshot.signing_keys;
        *self.authorization_requests.borrow_mut() = snapshot.authorization_requests;
        *self.authorization_codes.borrow_mut() = snapshot.authorization_codes;
        *self.families.borrow_mut() = snapshot.families;
        *self.tokens.borrow_mut() = snapshot.tokens;
        *self.code_grants.borrow_mut() = snapshot.code_grants;
        *self.device_grants.borrow_mut() = snapshot.device_grants;
    }
}

impl GatekeeperStore for FakeGatekeeperStore {
    type Tx<'a> = FakeGatekeeperTx<'a>;

    fn with_connection<T>(
        &self,
        f: impl FnOnce(&mut Self::Tx<'_>) -> Result<T, GatekeeperError>,
    ) -> Result<T, GatekeeperError> {
        f(&mut FakeGatekeeperTx { store: self })
    }

    fn transaction<T>(
        &self,
        f: impl FnOnce(&mut Self::Tx<'_>) -> Result<T, GatekeeperError>,
    ) -> Result<T, GatekeeperError> {
        // No real locking (the fake is single-threaded); the snapshot models the
        // one property the composed actions rely on — rollback on error — so a
        // partially-applied transaction never leaks into a later assertion.
        let snapshot = self.snapshot();
        let result = f(&mut FakeGatekeeperTx { store: self });
        if result.is_err() {
            self.restore(snapshot);
        }
        result
    }

    fn immediate_transaction<T>(
        &self,
        f: impl FnOnce(&mut Self::Tx<'_>) -> Result<T, GatekeeperError>,
    ) -> Result<T, GatekeeperError> {
        self.transaction(f)
    }
}

/// The fake's [`GatekeeperTx`] — a borrow of the store's maps. Interior
/// mutability (`RefCell`) does the real work; `&mut self` is only the trait's
/// shape.
pub(crate) struct FakeGatekeeperTx<'a> {
    store: &'a FakeGatekeeperStore,
}
