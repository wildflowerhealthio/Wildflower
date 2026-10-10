//! An in-memory [`RemotesStore`] fake for the
//! [`capabilities`](crate::domain::capabilities) unit tests, which exercise the
//! scope-gated capability operations and their semantic mapping onto
//! `NotFound`/`AlreadyExists`. It models the port's PRIMITIVE semantics —
//! `insert` reports a duplicate id as `false`, `get`/`update` report an absent id
//! as `None`, `delete` reports a miss as `false` — with no diesel and no
//! database, so the domain logic is testable without touching the `SQLite`
//! adapter (whose own coverage lives in [`crate::db`]).

use std::cell::RefCell;
use std::collections::HashMap;

use crate::domain::{Remote, RemoteError, RemotesStore};

/// An in-memory [`RemotesStore`] modelling the real primitive semantics, with no
/// diesel and no database. Lets the capabilities' store logic and semantic
/// mapping be exercised directly.
#[derive(Default)]
pub(crate) struct FakeRemotesStore {
    remotes: RefCell<HashMap<String, Remote>>,
}

impl RemotesStore for FakeRemotesStore {
    fn list(&self) -> Result<Vec<Remote>, RemoteError> {
        let mut remotes: Vec<Remote> = self.remotes.borrow().values().cloned().collect();
        remotes.sort_by(|a, b| (&a.added_at, &a.id).cmp(&(&b.added_at, &b.id)));
        Ok(remotes)
    }

    fn get(&self, id: &str) -> Result<Option<Remote>, RemoteError> {
        Ok(self.remotes.borrow().get(id).cloned())
    }

    fn insert(&self, remote: &Remote) -> Result<bool, RemoteError> {
        let mut remotes = self.remotes.borrow_mut();
        if remotes.contains_key(&remote.id) {
            return Ok(false);
        }
        remotes.insert(remote.id.clone(), remote.clone());
        Ok(true)
    }

    fn update(
        &self,
        id: &str,
        name: &str,
        tag: &str,
        config: &serde_json::Value,
    ) -> Result<Option<Remote>, RemoteError> {
        let mut remotes = self.remotes.borrow_mut();
        let Some(existing) = remotes.get_mut(id) else {
            return Ok(None);
        };
        existing.name = name.to_owned();
        existing.tag = tag.to_owned();
        existing.config = config.clone();
        Ok(Some(existing.clone()))
    }

    fn delete(&self, id: &str) -> Result<bool, RemoteError> {
        Ok(self.remotes.borrow_mut().remove(id).is_some())
    }
}
