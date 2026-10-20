//! The in-memory [`FakeGrantStore`] and the fixtures the domain unit tests
//! share. It models the port's semantics with no diesel and no database:
//! every primitive lives on [`FakeGrantTx`], implemented per table in `tx`,
//! and the [`GrantStore`] scopes hand one out. Its
//! [`write`](GrantStore::write) scope snapshots the tables first and restores
//! them when the closure returns `Err`, so a failed operation rolls back
//! exactly as the `SQLite` adapter's would; its [`read`](GrantStore::read)
//! scope runs the closure as it is. The adapter's own SQL coverage (and its
//! real lock semantics) live in `crate::db`.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use crate::domain::authorization_code::AuthorizationCode;
use crate::domain::authorization_request::AuthorizationRequest;
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::browser_session::BrowserSession;
use crate::domain::client::Client;
use crate::domain::grant::{AuthorizationCodeGrant, DeviceGrant};
use crate::domain::launch_context::LaunchContext;
use crate::domain::refresh_token::{RefreshToken, RefreshTokenFamily};
use crate::domain::signing_key::SigningKey;
use crate::domain::GrantStore;

mod fixtures;
mod tx;

pub(crate) use fixtures::{
    approve_stored, authenticated_public_client, client, code_grant, code_request,
    code_request_for, delegated_scopes, device_request, fixture_code, owned_scopes,
    pending_request, redeemed_code, registering_delegated_scopes, seed_active_signing_key,
    seed_fixture_browser_session, with_status, NothingRevoked, RecordingOwnerApproval, FIXTURE_SID,
};

/// An in-memory [`GrantStore`] modelling the primitive port semantics with
/// no diesel and no database. Cloning it shares the tables, so a test can hand
/// one clone to a capability and arrange and observe rows through another.
#[derive(Clone, Default)]
pub(crate) struct FakeGrantStore {
    tables: Rc<FakeTables>,
}

/// The fake's tables, one map per table.
#[derive(Default)]
pub(crate) struct FakeTables {
    clients: RefCell<HashMap<String, Client>>,
    signing_keys: RefCell<Vec<SigningKey>>,
    authorization_requests: RefCell<HashMap<String, AuthorizationRequest>>,
    authorization_codes: RefCell<HashMap<String, AuthorizationCode>>,
    families: RefCell<HashMap<String, RefreshTokenFamily>>,
    tokens: RefCell<HashMap<String, RefreshToken>>,
    code_grants: RefCell<HashMap<String, AuthorizationCodeGrant>>,
    device_grants: RefCell<HashMap<String, DeviceGrant>>,
    launch_contexts: RefCell<HashMap<String, LaunchContext>>,
    browser_sessions: RefCell<HashMap<String, BrowserSession>>,
    /// The (`sid`, `client_id`) pairs gone on past the limited page.
    session_shortfall_acknowledgements: RefCell<HashSet<(String, String)>>,
}

/// A clone of every map, taken before a write scope runs so it can be restored
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
    launch_contexts: HashMap<String, LaunchContext>,
    browser_sessions: HashMap<String, BrowserSession>,
    session_shortfall_acknowledgements: HashSet<(String, String)>,
}

impl FakeTables {
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
            launch_contexts: self.launch_contexts.borrow().clone(),
            browser_sessions: self.browser_sessions.borrow().clone(),
            session_shortfall_acknowledgements: self
                .session_shortfall_acknowledgements
                .borrow()
                .clone(),
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
        *self.launch_contexts.borrow_mut() = snapshot.launch_contexts;
        *self.browser_sessions.borrow_mut() = snapshot.browser_sessions;
        *self.session_shortfall_acknowledgements.borrow_mut() =
            snapshot.session_shortfall_acknowledgements;
    }
}

impl GrantStore for FakeGrantStore {
    type Tx<'a> = FakeGrantTx<'a>;

    fn read<T, E: From<AuthorizationServerError>>(
        &self,
        f: impl FnOnce(&mut Self::Tx<'_>) -> Result<T, E>,
    ) -> Result<T, E> {
        f(&mut FakeGrantTx {
            store: &self.tables,
        })
    }

    fn write<T, E: From<AuthorizationServerError>>(
        &self,
        f: impl FnOnce(&mut Self::Tx<'_>) -> Result<T, E>,
    ) -> Result<T, E> {
        // No real locking (the fake is single-threaded); the snapshot models
        // the one property the flows rely on, rollback on error, so a
        // partially applied scope never leaks into a later assertion.
        let snapshot = self.tables.snapshot();
        let result = f(&mut FakeGrantTx {
            store: &self.tables,
        });
        if result.is_err() {
            self.tables.restore(snapshot);
        }
        result
    }
}

impl FakeGrantStore {
    /// A handle on the maps outside any scope, for a test to arrange rows
    /// and observe them.
    pub(crate) fn tx(&self) -> FakeGrantTx<'_> {
        FakeGrantTx {
            store: &self.tables,
        }
    }
}

/// The fake's [`GrantTx`] — a borrow of the store's maps. Interior
/// mutability (`RefCell`) does the real work; `&mut self` is only the trait's
/// shape.
pub(crate) struct FakeGrantTx<'a> {
    store: &'a FakeTables,
}
