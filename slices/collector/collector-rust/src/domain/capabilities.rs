//! Scope-gated capabilities for the `/collector/remotes` surface — the
//! collector slice's copy of the default-safe authorization pattern (the generic
//! machinery lives in [`scope_capabilities_rust`]; the pattern originated on
//! gatekeeper's `/access` surface, recipe in
//! `docs/Authorization/Scope-Gated Endpoints How-To.md`). Each capability is the
//! only door to the store for its operations, so a handler that skips the scope
//! check has no way to touch data.
//!
//! The scope **resource** is [`WildflowerResource::Accounts`] — a collector
//! remote is an *account* at a data origin, and a remote's stored `config` can
//! carry that origin's credentials (e.g. a pharmacy login), so even a read needs
//! the `.r` permission. The **code** entity stays `Remote` throughout this crate;
//! only the scope vocabulary renames it to `Accounts`.
//!
//! Every capability is the **fixed-scope** flavour (one static scope gates the
//! whole capability): the `Scoped` extractor checks the scope before `build`
//! runs, so the capability method never re-checks. Each is **generic over the
//! [`RemotesStore`] port** (`Cap<S: RemotesStore>`) and holds the store handle
//! **lifted from the state** (never an `Arc<CollectorState>` it reaches into), so
//! its logic is unit-testable against the in-memory fake. The
//! [`FixedScopeCapability`](scope_capabilities_rust::FixedScopeCapability)
//! bindings that name the concrete `SqliteRemotesStore` and build a capability
//! from the router state live beside the state in
//! [`crate::state`](crate::state) — so this module stays store-agnostic and free
//! of `crate::http`.
//!
//! The (resource, permission) → required-scope mapping lives in one place — each
//! capability's `*_scopes()` function — read by **both** its `Capability` binding
//! and [`grantable_collector_scopes`], so *enforced* and *grantable* can't drift.

use chrono::{SecondsFormat, Utc};
use scopes_rust::{Permission, Scope, WildflowerResource};

use crate::domain::{required_config_tag, Remote, RemoteError, RemotesStore};

/// The scope gating [`RemotesReader`] — `wildflower/Accounts.r`. Reads require
/// `.r` (not merely authentication) because the returned `config` can carry the
/// origin's credentials. Shared by the capability's `FixedScopeCapability`
/// binding and [`grantable_collector_scopes`] so enforced and grantable can't
/// drift.
pub(crate) fn remotes_reader_scopes() -> Vec<Scope> {
    vec![Scope::wildflower(
        WildflowerResource::Accounts,
        Permission::READ,
    )]
}

/// The scope gating [`RemotesCreator`] — `wildflower/Accounts.c`.
pub(crate) fn remotes_creator_scopes() -> Vec<Scope> {
    vec![Scope::wildflower(
        WildflowerResource::Accounts,
        Permission::CREATE,
    )]
}

/// The scope gating [`RemotesEditor`] — `wildflower/Accounts.u`.
pub(crate) fn remotes_editor_scopes() -> Vec<Scope> {
    vec![Scope::wildflower(
        WildflowerResource::Accounts,
        Permission::UPDATE,
    )]
}

/// The scope gating [`RemotesDeleter`] — `wildflower/Accounts.d`.
pub(crate) fn remotes_deleter_scopes() -> Vec<Scope> {
    vec![Scope::wildflower(
        WildflowerResource::Accounts,
        Permission::DELETE,
    )]
}

/// The `wildflower/Accounts.*` scopes the `/collector/remotes` surface enforces,
/// deduplicated in declaration order — the registry mapping *capability →
/// required scope*. Because it reads the very `*_scopes()` functions the
/// `Capability` bindings enforce, what a token can be *granted* and what it is
/// *checked against* come from one source. The per-slice grantable vocabulary;
/// nothing consumes it yet (the tests below pin it until a consent surface does).
#[must_use]
pub fn grantable_collector_scopes() -> Vec<Scope> {
    // One scope each and all distinct (`.r`/`.c`/`.u`/`.d`), so no dedup is
    // needed — but the order is the read/create/update/delete the table declares.
    [
        remotes_reader_scopes(),
        remotes_creator_scopes(),
        remotes_editor_scopes(),
        remotes_deleter_scopes(),
    ]
    .into_iter()
    .flatten()
    .collect()
}

/// Read access to collector remotes — `GET /collector/remotes[/{id}]`, gated by
/// `wildflower/Accounts.r`. Generic over the store port so it's unit-testable
/// against the fake; the binding instantiates it over the concrete
/// `SqliteRemotesStore`.
pub(crate) struct RemotesReader<S: RemotesStore> {
    store: S,
}

impl<S: RemotesStore> RemotesReader<S> {
    /// Build the reader over a store handle lifted from the state.
    pub(crate) fn new(store: S) -> Self {
        RemotesReader { store }
    }

    /// Every remote, oldest first — the `GET /collector/remotes` catalogue.
    ///
    /// # Errors
    ///
    /// [`RemoteError::Infrastructure`] if the store read fails.
    pub(crate) fn list(&self) -> Result<Vec<Remote>, RemoteError> {
        self.store.list()
    }

    /// A single remote by id, or [`RemoteError::NotFound`] when absent.
    ///
    /// # Errors
    ///
    /// [`RemoteError::NotFound`] when no remote has this id;
    /// [`RemoteError::Infrastructure`] if the store read fails.
    pub(crate) fn get(&self, id: &str) -> Result<Remote, RemoteError> {
        self.store
            .get(id)?
            .ok_or_else(|| RemoteError::NotFound { id: id.to_owned() })
    }
}

/// Create a collector remote — `POST /collector/remotes`, gated by
/// `wildflower/Accounts.c`. Separate from [`RemotesReader`] so a read handler
/// structurally cannot create.
pub(crate) struct RemotesCreator<S: RemotesStore> {
    store: S,
}

impl<S: RemotesStore> RemotesCreator<S> {
    /// Build the creator over a store handle lifted from the state.
    pub(crate) fn new(store: S) -> Self {
        RemotesCreator { store }
    }

    /// Store a new remote — denormalize `config._tag` into `tag`, stamp
    /// `added_at`, and insert. Returns [`RemoteError::AlreadyExists`] when the
    /// client-minted id is already taken (the insert affected no row) rather than
    /// overwriting.
    ///
    /// # Errors
    ///
    /// [`RemoteError::InvalidConfig`] when the config carries no string `_tag`;
    /// [`RemoteError::AlreadyExists`] when the id is already taken;
    /// [`RemoteError::Infrastructure`] if the store write fails.
    pub(crate) fn create(
        &self,
        id: String,
        name: String,
        config: serde_json::Value,
    ) -> Result<Remote, RemoteError> {
        let tag = required_config_tag(&config)?;
        let remote = Remote {
            id,
            name,
            tag,
            config,
            // ISO-8601 UTC with milliseconds (e.g. `2026-06-17T14:29:22.363Z`) —
            // the encoding the TS `Schema.DateTimeUtc` round-trips and the seed
            // migration pins.
            added_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        };
        if self.store.insert(&remote)? {
            Ok(remote)
        } else {
            Err(RemoteError::AlreadyExists {
                id: remote.id.clone(),
            })
        }
    }
}

/// Replace a collector remote's `name` + `config` — `PUT /collector/remotes/{id}`,
/// gated by `wildflower/Accounts.u`.
pub(crate) struct RemotesEditor<S: RemotesStore> {
    store: S,
}

impl<S: RemotesStore> RemotesEditor<S> {
    /// Build the editor over a store handle lifted from the state.
    pub(crate) fn new(store: S) -> Self {
        RemotesEditor { store }
    }

    /// Full-replace a remote's `name` + `config` (re-denormalizing `tag` from the
    /// new `config._tag`; `id` and `added_at` are immutable), or
    /// [`RemoteError::NotFound`] on an unknown id / [`RemoteError::InvalidConfig`]
    /// on a config with no string `_tag`.
    ///
    /// # Errors
    ///
    /// [`RemoteError::InvalidConfig`] when the config carries no string `_tag`;
    /// [`RemoteError::NotFound`] when no remote has this id;
    /// [`RemoteError::Infrastructure`] if the store write fails.
    pub(crate) fn update(
        &self,
        id: &str,
        name: &str,
        config: &serde_json::Value,
    ) -> Result<Remote, RemoteError> {
        let tag = required_config_tag(config)?;
        self.store
            .update(id, name, &tag, config)?
            .ok_or_else(|| RemoteError::NotFound { id: id.to_owned() })
    }
}

/// Delete a collector remote — `DELETE /collector/remotes/{id}`, gated by
/// `wildflower/Accounts.d`.
pub(crate) struct RemotesDeleter<S: RemotesStore> {
    store: S,
}

impl<S: RemotesStore> RemotesDeleter<S> {
    /// Build the deleter over a store handle lifted from the state.
    pub(crate) fn new(store: S) -> Self {
        RemotesDeleter { store }
    }

    /// Remove a remote by id, or [`RemoteError::NotFound`] when no remote has it.
    ///
    /// # Errors
    ///
    /// [`RemoteError::NotFound`] when no remote has this id;
    /// [`RemoteError::Infrastructure`] if the store write fails.
    pub(crate) fn delete(&self, id: &str) -> Result<(), RemoteError> {
        if self.store.delete(id)? {
            Ok(())
        } else {
            Err(RemoteError::NotFound { id: id.to_owned() })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::test_fake::FakeRemotesStore;

    fn config(tag: &str) -> serde_json::Value {
        serde_json::json!({ "_tag": tag, "rootUrl": "https://x" })
    }

    /// Seed a remote straight through the port (bypassing a capability) so the
    /// capability under test can then own the store by value.
    fn seed(store: &FakeRemotesStore, id: &str, name: &str, tag: &str) {
        store
            .insert(&Remote {
                id: id.to_owned(),
                name: name.to_owned(),
                tag: tag.to_owned(),
                config: config(tag),
                added_at: "2026-07-01T00:00:00.000Z".to_owned(),
            })
            .expect("seed insert");
    }

    /// A reader over a fake store seeded with one remote lists it and fetches it
    /// by id, and reports an unknown id as `NotFound` — the capability reads
    /// through the store handle it holds.
    #[test]
    fn reader_lists_and_gets_through_the_store_handle() {
        let store = FakeRemotesStore::default();
        seed(&store, "r1", "One", "fhir-r4");
        let reader = RemotesReader::new(store);
        assert_eq!(reader.list().unwrap().len(), 1);
        assert_eq!(reader.get("r1").unwrap().name, "One");
        assert!(matches!(
            reader.get("ghost"),
            Err(RemoteError::NotFound { .. })
        ));
    }

    /// The reader lists rows in a total order — `added_at` then `id`. Both seeds
    /// share an `added_at`, so the `id` tiebreak ("a" < "b") fixes the order.
    #[test]
    fn reader_lists_remotes_in_a_total_order() {
        let store = FakeRemotesStore::default();
        seed(&store, "b", "B", "fhir-r4");
        seed(&store, "a", "A", "fhir-r4");
        let reader = RemotesReader::new(store);
        let ids: Vec<String> = reader.list().unwrap().into_iter().map(|r| r.id).collect();
        assert_eq!(ids, vec!["a", "b"]);
    }

    /// A creator inserts a fresh remote (denormalizing `tag`, stamping a
    /// millisecond-precision `added_at`) and reports a taken id as `AlreadyExists`.
    #[test]
    fn creator_inserts_then_conflicts_on_a_taken_id() {
        let creator = RemotesCreator::new(FakeRemotesStore::default());
        let created = creator
            .create("r1".to_owned(), "One".to_owned(), config("rexall"))
            .expect("create");
        assert_eq!(created.tag, "rexall", "tag denormalized from config._tag");
        assert!(
            created.added_at.len() == 24
                && created.added_at.ends_with('Z')
                && created.added_at.contains('.'),
            "added_at is ISO-8601 UTC with milliseconds, got {}",
            created.added_at,
        );
        assert_eq!(
            creator.create("r1".to_owned(), "Dup".to_owned(), config("fhir-r4")),
            Err(RemoteError::AlreadyExists {
                id: "r1".to_owned()
            }),
        );
    }

    /// A create with a config carrying no string `_tag` is rejected as
    /// `InvalidConfig` before anything is stored.
    #[test]
    fn creator_rejects_a_config_without_a_string_tag() {
        let creator = RemotesCreator::new(FakeRemotesStore::default());
        assert!(matches!(
            creator.create(
                "bad".to_owned(),
                "n".to_owned(),
                serde_json::json!({ "rootUrl": "x" }),
            ),
            Err(RemoteError::InvalidConfig { .. }),
        ));
    }

    /// An editor rewrites `name` + `config` on an existing remote, and reports an
    /// unknown id as `NotFound`.
    #[test]
    fn editor_updates_then_not_found_on_unknown() {
        let store = FakeRemotesStore::default();
        seed(&store, "r1", "One", "fhir-r4");
        let editor = RemotesEditor::new(store);
        let updated = editor
            .update("r1", "Renamed", &config("rexall"))
            .expect("update");
        assert_eq!(updated.name, "Renamed");
        assert_eq!(updated.tag, "rexall", "tag re-denormalized");
        assert!(matches!(
            editor.update("ghost", "n", &config("fhir-r4")),
            Err(RemoteError::NotFound { .. }),
        ));
    }

    /// An update with a config carrying no string `_tag` is rejected as
    /// `InvalidConfig`.
    #[test]
    fn editor_rejects_a_config_without_a_string_tag() {
        let store = FakeRemotesStore::default();
        seed(&store, "r1", "One", "fhir-r4");
        let editor = RemotesEditor::new(store);
        assert!(matches!(
            editor.update("r1", "n", &serde_json::json!({ "rootUrl": "x" })),
            Err(RemoteError::InvalidConfig { .. }),
        ));
    }

    /// A deleter removes the row then reports the second delete as a miss.
    #[test]
    fn deleter_removes_then_misses() {
        let store = FakeRemotesStore::default();
        seed(&store, "r1", "One", "fhir-r4");
        let deleter = RemotesDeleter::new(store);
        assert_eq!(deleter.delete("r1"), Ok(()));
        assert!(matches!(
            deleter.delete("r1"),
            Err(RemoteError::NotFound { .. })
        ));
    }

    /// The grantable vocabulary is exactly `wildflower/Accounts.{r,c,u,d}`, in
    /// that order — the scopes the four capabilities enforce. Pins both the
    /// rename (`Remote` code entity → `Accounts` scope resource) and the letter
    /// permissions so a drift in either is a red test, not a silent lock-out.
    #[test]
    fn grantable_scopes_are_accounts_r_c_u_d() {
        assert_eq!(
            scopes_rust::render_scopes(&grantable_collector_scopes()),
            vec![
                "wildflower/Accounts.r".to_owned(),
                "wildflower/Accounts.c".to_owned(),
                "wildflower/Accounts.u".to_owned(),
                "wildflower/Accounts.d".to_owned(),
            ],
        );
    }

    /// A typo in a required-scope spelling would fall to `Scope::Unknown`, which
    /// an owner's `wildflower/*.cruds` can't cover — locking the owner out.
    /// Assert each grantable scope is a real Wildflower resource scope so that
    /// can't ship.
    #[test]
    fn every_grantable_scope_is_a_known_wildflower_resource() {
        for scope in grantable_collector_scopes() {
            assert!(
                matches!(scope, Scope::WildflowerResource(_)),
                "required scope {scope} is not a wildflower resource scope",
            );
        }
    }

    /// Registry-completeness guard: every capability declares exactly one
    /// `*_scopes()` function, and [`grantable_collector_scopes`]'s array must list
    /// all of them. A capability added without registering enforces a scope the
    /// grantable vocabulary never offers — a silent lock-out. Counting the scope
    /// functions textually keeps honest additions honest.
    #[test]
    fn every_capability_scope_fn_is_registered_in_the_grantable_vocabulary() {
        // Assembled from parts so this test's own source doesn't contain the
        // literal it scans for (which would make it count itself).
        let needle = concat!("_scopes() ->", " Vec<Scope>");
        let source = include_str!("capabilities.rs");
        // Every scope-returning signature: the four capability fns plus
        // `grantable_collector_scopes` itself (whose name also ends the same way),
        // so subtract that one to leave the capability count.
        let capability_scope_fns = source.matches(needle).count() - 1;
        // One array entry per capability's scope function. Update BOTH when adding
        // a capability: its `*_scopes()` fn and the `grantable_collector_scopes()`
        // array.
        let declared_entries = 4;
        assert_eq!(
            capability_scope_fns, declared_entries,
            "found {capability_scope_fns} capability scope functions but \
             grantable_collector_scopes() declares {declared_entries}; register the new \
             capability in its array",
        );
    }

    /// Default-safety guard: the scope-gated `/collector/remotes` handler files
    /// must reach the store **only** through a `Scoped<…>` capability — never a
    /// raw router `State<…>` or a direct `.store` field access. Bypassing the
    /// capability would need one of these tokens, and this test fails if one
    /// appears, so a forgotten scope check can't ship silently. (Mirrors
    /// gatekeeper's `access_handlers_reach_the_store_only_through_capabilities`.)
    ///
    /// The routes tree is enumerated at test time, so a NEW handler file is
    /// guarded by default. (Advisory-strength: the needles are textual.)
    #[test]
    fn remotes_handlers_reach_the_store_only_through_capabilities() {
        // Raw router state or a direct store field access — the only ways to
        // reach a remote without a capability.
        const FORBIDDEN: &[&str] = &["State<", ".store"];
        let routes_dir =
            std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/src/http/routes"));
        let mut checked = 0;
        for path in rs_files_under(routes_dir) {
            let relative = path
                .strip_prefix(routes_dir)
                .expect("enumerated under routes_dir")
                .to_string_lossy()
                .replace('\\', "/");
            // Module glue and the handler-test file (`routes/mod.rs`) are exempt —
            // every operation handler lives in its own file and is gated.
            if relative.ends_with("mod.rs") {
                continue;
            }
            let source = std::fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("read handler source {relative}: {e}"));
            for needle in FORBIDDEN {
                assert!(
                    !source.contains(needle),
                    "scope-gated handler `{relative}` reaches the store directly \
                     (`{needle}`); acquire it through a `Scoped<…>` capability instead",
                );
            }
            checked += 1;
        }
        assert!(
            checked >= 5,
            "only {checked} handler files enumerated — did src/http/routes move?",
        );
    }

    fn rs_files_under(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
        let mut files = Vec::new();
        let entries =
            std::fs::read_dir(dir).unwrap_or_else(|e| panic!("enumerate {}: {e}", dir.display()));
        for entry in entries {
            let path = entry.expect("readable dir entry").path();
            if path.is_dir() {
                files.extend(rs_files_under(&path));
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                files.push(path);
            }
        }
        files.sort();
        files
    }
}
