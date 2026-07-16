# Scope-Gated Endpoints How-To

How to put a slice's HTTP endpoints behind **per-resource scope checks** using the
shared `scope_gating` machinery, so a forgotten permission check can't compile a
data-touching handler. The pattern originated on gatekeeper's `/access` surface
and now lives in `shared-structures-rust` for every slice to copy.

## Goal

Make the scope check **structural, not optional**: an endpoint reaches its store
_only_ through a scope-gated **service facade**. Acquiring the facade is the price
of admission — a handler that skips the check has no way to touch data. A
source-guard test then fails the build if any handler bypasses the facade.

The building blocks (`shared_structures_rust::scope_gating`, behind the
`scope-gating` Cargo feature):

- **`GatedService`** — a trait each facade implements: its router `State`, the
  `Claims` its authN layer inserts, the `required_scopes()` it gates on, and a
  `build(state, granted)` constructor.
- **`Scoped<F>`** — an axum extractor that yields facade `F` only if the caller's
  claims cover `F::required_scopes()`, else a `403` naming the missing scopes.
- **`ScopeClaims`** / **`GrantedScopes`** — the claims contract. `ScopeClaims` is
  the ready-made value an authN middleware inserts; a slice with a richer claims
  type implements `GrantedScopes` on it instead.
- **`insufficient_scope(missing)`** — the shared `403` body.

## Recipe

### 1. Depend on the machinery

In the slice's `-rust` `Cargo.toml`:

```toml
scopes-rust = { path = "../../scopes/scopes-rust" }
shared-structures-rust = { path = "../../shared-structures/shared-structures-rust", features = ["scope-gating"] }
```

### 2. Make sure claims reach the router

`Scoped<F>` reads `F::Claims` out of the request extensions, so an authN layer
must run first and insert them. For a router the host composes behind
`gatekeeper_rust::layer_router_with_gatekeeper_auth_gating`, this is already done:
the bearer gate inserts a `ScopeClaims` after verifying the token, so downstream
slices read scopes **without depending on gatekeeper's domain claims type**. A
slice that mounts its own authN layer inserts its own claims value (implementing
`GrantedScopes`).

### 3. Define the facades

One facade per capability. Each is the only door to the store for its operations.

```rust
use std::sync::Arc;
use scopes_rust::{Grant, Permission, Scope};
use shared_structures_rust::scope_gating::{GatedService, ScopeClaims};

pub(crate) struct WidgetsReader {
    state: Arc<WidgetsState>,
}

impl GatedService for WidgetsReader {
    type State = Arc<WidgetsState>;
    type Claims = ScopeClaims;

    fn required_scopes() -> Vec<Scope> {
        vec![Scope::wildflower(WildflowerResource::Widget, Permission::READ)]
    }

    fn build(state: Arc<WidgetsState>, _granted: &Grant) -> Self {
        WidgetsReader { state }
    }
}

impl WidgetsReader {
    pub(crate) fn list(&self) -> Result<Vec<Widget>, WidgetError> {
        actions::all_widgets(&self.state.store)
    }
}
```

Build required scopes with the typed constructors in `scopes-rust`
(`Scope::wildflower`, `Scope::wildflower_all`, `Scope::fhir_system_all`) rather
than parsing strings — a typo is then a compile error, not a silent `Unknown`
scope no token can cover.

### 4. Take `Scoped<F>` in the handler

```rust
pub(crate) async fn handle_list_widgets(
    widgets: Scoped<WidgetsReader>,
) -> Result<Json<Vec<Widget>>, WidgetError> {
    Ok(Json(widgets.list()?))
}
```

`Scoped<F>` derefs to `F`, so the handler just calls facade methods. It never sees
`State<…>` or the store — that's the point.

### 5. Guard it with a source test

Copy the `include_str!` source-guard test (see
`gatekeeper-rust/src/http/scoped/facades/mod.rs` or
`databases-rust/src/http/scoped.rs`): list the handler files and assert their
source never contains `State<` or a direct store accessor. A future handler that
reaches around the facade then fails the build.

## Two flavours of gate

- **Fixed capability** (gatekeeper's `/access`): the facade's scope is constant,
  so `required_scopes()` returns it and `build` ignores `granted`. The `Scoped`
  extractor is the whole gate.
- **Data-dependent** (databases' per-database scope): the required scope depends
  on _which_ resource, so `required_scopes()` is empty ("authenticated only") and
  the facade holds the caller's `Grant` (from `build(state, granted)`) and checks
  coverage inside each method — returning `insufficient_scope(...)` on a miss.
  Run that check **before** the existence check so an under-scoped caller gets a
  `403` regardless of whether the resource exists (no existence leak).

## Worked examples

- **Fixed:** `slices/gatekeeper/gatekeeper-rust/src/http/scoped/` — the `/access`
  admin surface (`GrantsReader`, `GrantsRevoker`, `ConsentReader`,
  `ConsentDecider`, `TokenRevoker`).
- **Data-dependent:** `slices/databases/databases-rust/src/http/scoped.rs` —
  `DatabasesReader` / `DatabasesDeleter`, gated per database by the `read_scope` /
  `delete_scope` the host declares on each `DatabaseDescriptor`.

## References

- `slices/shared-structures/shared-structures-rust/src/scope_gating.rs` — the
  machinery.
- [Effect Patterns Reference](../Effect/Patterns%20Reference.md) — the repository
  pattern the facades delegate to.
