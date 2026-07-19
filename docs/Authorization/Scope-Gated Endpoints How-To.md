# Scope-Gated Endpoints How-To

How to put a slice's HTTP endpoints behind **per-resource scope checks** using
the shared `scope-capabilities-rust` machinery, so a forgotten permission check
can't compile a data-touching handler. The pattern originated on gatekeeper's
`/access` surface and now lives in the scopes slice for every slice to copy. For
_why_ it is shaped this way, read the
[Scope-Gated Endpoints Explanation](./Scope-Gated%20Endpoints%20Explanation.md).

## Goal

Make the scope check **structural, not optional**: an endpoint reaches its store
_only_ through a scope-gated **capability**. Acquiring the capability is the price
of admission — a handler that skips the check has no way to touch data. A
source-guard test then fails the build if any handler bypasses the capability.

The building blocks (`scope_capabilities_rust`):

- **`FixedScopeCapability`** — the trait a capability implements when one static
  scope set gates it (the common case): its router `State`, the `Claims` its authN
  layer inserts, the `required_scopes()` it gates on, and a `build(state)`
  constructor. A blanket impl lifts it into `Capability`.
- **`Capability`** — the trait the `Scoped` extractor drives, and the one a
  **data-dependent** capability implements directly (empty `required_scopes()`,
  `build(state, granted)` stores the caller's `Grant`).
- **`Scoped<F>`** — an axum extractor that yields capability `F` only if the
  caller's claims cover `F::required_scopes()`, else a `403` naming the missing
  scopes.
- **`ScopeClaims`** / **`GrantedScopes`** — the claims contract. `ScopeClaims` is
  the ready-made value an authN middleware inserts; a slice with a richer claims
  type implements `GrantedScopes` on it instead (via `grant_from_scope_claim`).
- **`insufficient_scope(missing)`** / **`InsufficientScopeBody`** — the shared
  `403` body (derive `utoipa::ToSchema` via the `openapi` feature to document it).

## Recipe

### 1. Depend on the machinery

In the slice's `-rust` `Cargo.toml`:

```toml
scopes-rust = { path = "../../scopes/scopes-rust" }
# add features = ["openapi"] to declare the 403 body in your utoipa responses
scope-capabilities-rust = { path = "../../scopes/scope-capabilities-rust" }
```

### 2. Make sure claims reach the router (the authN pair)

`Scoped<F>` reads `F::Claims` out of the request extensions, so an authN layer
must run first and insert them. This is one half of a **pair** of claims-inserting
middlewares (see the Explanation):

- A router the host composes behind
  `gatekeeper_rust::layer_router_with_gatekeeper_auth_gating` is already covered —
  `require_valid_bearer_token` inserts a `ScopeClaims` after verifying the token,
  so downstream slices read scopes **without depending on gatekeeper's domain
  claims type**.
- Gatekeeper's own `/access` uses `require_valid_session`, which inserts the rich
  `VerifiedClaims` (implementing `GrantedScopes`).

A slice that mounts its own authN layer inserts its own claims value the same way.

### 3. Define the capabilities

One capability per (resource, permission). Each is the only door to the store for
its operations. For the fixed-scope flavour, implement `FixedScopeCapability`:

```rust
use std::sync::Arc;
use scopes_rust::{Permission, Scope, WildflowerResource};
use scope_capabilities_rust::{FixedScopeCapability, ScopeClaims};

pub(crate) struct WidgetsReader {
    state: Arc<WidgetsState>,
}

impl FixedScopeCapability for WidgetsReader {
    type State = Arc<WidgetsState>;
    type Claims = ScopeClaims;

    fn required_scopes() -> Vec<Scope> {
        vec![Scope::wildflower(WildflowerResource::Widget, Permission::READ)]
    }

    fn build(state: Arc<WidgetsState>) -> Self {
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

**Register each capability** in the slice's grantable-scope list (gatekeeper's
`grantable_admin_scopes`) if it keeps one: an enforced scope that never appears in
the grantable vocabulary is a scope no client can ever be granted — a silent
lock-out. Gatekeeper's registry-completeness test counts `impl` lines against the
registry so a new capability that isn't registered fails the build.

### 4. Take `Scoped<F>` in the handler

```rust
pub(crate) async fn handle_list_widgets(
    widgets: Scoped<WidgetsReader>,
) -> Result<Json<Vec<Widget>>, WidgetError> {
    Ok(Json(widgets.list()?))
}
```

`Scoped<F>` derefs to `F`, so the handler just calls capability methods. It never
sees `State<…>` or the store — that's the point.

### 5. Guard it with a source test

Copy the source-guard test (see
`gatekeeper-rust/src/domain/capabilities/mod.rs` or
`databases-rust/src/domain/capabilities.rs`): it enumerates the routes directory at
test time and asserts each handler's source never contains `State<` or a direct
store accessor, so a NEW handler file is guarded by default and must be
consciously exempted to escape. A future handler that reaches around the
capability then fails the build.

## Two flavours of gate

- **Fixed capability** (gatekeeper's `/access`): the scope is constant, so
  implement `FixedScopeCapability` — `required_scopes()` returns it and `build`
  takes only `state`. The `Scoped` extractor is the whole gate.
- **Data-dependent** (databases' per-database scope): the required scope depends
  on _which_ resource, so implement `Capability` directly — `required_scopes()` is
  empty ("authenticated only") and `build(state, granted)` stores the caller's
  `Grant`. Do the per-resource check through **one** accessor that resolves the
  resource _and_ proves the scope together (databases' `authorized_descriptor`),
  so a method can't look a resource up without the check. Run that check **before**
  the on-disk existence check so an under-scoped caller gets a `403` regardless of
  whether the resource exists on disk. (Catalogue membership — which ids the host
  declares — is separately public to any authenticated caller, so a `404` for an
  uncatalogued id is not a leak.)

## Canonical layout

Copy gatekeeper's layout so the third slice doesn't invent a fourth shape.
Capabilities live in **`domain/`**, not `http/` — a capability owns its slice's
operation, so it belongs beside the store port, and keeping it out of `http/`
lets a guard test assert `domain/` never imports `crate::http`.

- `domain/capabilities/` — a module (dir or single `capabilities.rs`) holding the
  capability structs + their operation logic and the source-guard test. A
  store-touching capability is **generic over the store port** (`Cap<S: Store>`)
  and holds its port dependencies (store, revocation, publisher, …) as fields —
  **lifted from the state**, never an `Arc<…State>` it reaches into — so its logic
  is unit-testable against an in-memory fake.
- The `Capability`/`FixedScopeCapability` **bindings** — which name the concrete
  store adapter and `build` a capability from the router state — live in the
  composition layer beside the state (`crate::live_bindings`, one binding file per
  capability), so `domain/` stays store-agnostic. The router state itself lives at
  the crate root (`crate::live_bindings::state`), not under `http/`, for the same
  reason (`domain/` builds capabilities from it).
- Owner-UI read models the `GET` handlers return live in `domain/` too (beside the
  capability that produces them), since they're pure data.

## Worked examples

- **Fixed:** `slices/gatekeeper/gatekeeper-rust/src/domain/capabilities/` — the
  `/access` admin surface (`GrantsReader`, `GrantsRevoker`, `ConsentReader`,
  `ConsentDecider`, `TokenRevoker`), generic over `GatekeeperStore`, bound to the
  concrete store in `gatekeeper-rust/src/live_bindings/` (one binding file per
  capability).
- **Data-dependent:** `slices/databases/databases-rust/src/domain/capabilities.rs` —
  `DatabasesReader` / `DatabasesDeleter`, gated per database by the `read_scope` /
  `delete_scope` the host declares on each `DatabaseDescriptor`, operating through
  the `DatabaseFiles` port (stubbed with an in-memory fake in the unit tests).
- **The authN-pair contract:**
  `gatekeeper-rust/tests/integration/smoke.rs::bearer_gate_inserts_scope_claims_a_downstream_capability_reads`
  drives the real bearer gate into the real databases capability.

## References

- [Scope-Gated Endpoints Explanation](./Scope-Gated%20Endpoints%20Explanation.md)
  — the design rationale (default-safe capabilities, the two flavours, the claims
  pair).
- `slices/scopes/scope-capabilities-rust/src/lib.rs` — the machinery.
- [Effect Patterns Reference](../Effect/Patterns%20Reference.md) — the repository
  pattern the capabilities delegate to.
