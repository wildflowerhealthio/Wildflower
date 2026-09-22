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
- **`AuthenticatedCapability`** / **`Authenticated<F>`** — the authenticated-only
  flavour: no scope, the caller's own claims handed to `build` whole.
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

- A router the host layers with
  `gatekeeper_rust::gatekeeper_auth_middleware` is already covered —
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

**Coverage never crosses the SMART v1-word / v2-letter grammars.** A required
scope like `system/*.rs` (a letter bag) is covered by an owner's `system/*.cruds`
(also a letter bag) but not by the v1 word `read`, and vice-versa — so keep a
required scope in the grammar the covering grant uses (reach for the letter bag,
not the `read` word). This bites anywhere scopes are compared across the two
grammars, and the fix is always to widen to the alternate canonical form first:
the token minter widens every granted scope to both forms in bulk with
`scopes_rust::with_alternate_canonical_forms` before it mints, so a token covers
regardless of the grammar the required scope is spelled in; and gatekeeper's
owner-approval clamp (`ensure_approver_covers`, enforcing "an owner can't delegate
more than they hold") widens each scope per-scope with
`Scope::as_alternate_canonical_form` before its coverage check — clamping **only**
resource scopes (`FhirResource` / `WildflowerResource`) so identity/session
markers (`openid`, `offline_access`, `launch`) pass through unclamped rather than
blocking a legitimate approval.

**Register each capability** in the slice's grantable-scope list (gatekeeper's
`grantable_admin_scopes`) if it keeps one: an enforced scope that never appears in
the grantable vocabulary is a scope no client can ever be granted — a silent
lock-out. Gatekeeper's registry-completeness test counts `impl` lines against the
registry so a new capability that isn't registered fails the build. That registry
function must be `pub fn`, not `pub(crate)` — a `pub use` re-export can't promote a
`pub(crate)` item (E0364), and making it `pub` also silences the dead-code lint it
would otherwise trip under `-D warnings` while nothing yet consumes it.

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

### 6. Document the `403` once (only if the surface is OpenAPI-documented)

If the slice's handlers are collected into a `utoipa` `OpenApiRouter` (they carry
`#[utoipa::path]` and feed a committed spec), declare the `403 InsufficientScope`
**once**, where the slice assembles its `OpenApi`, rather than repeating
`#[utoipa::path(responses((status = 403, …)))]` on every gated handler:

1. Register the shared body on the slice's `ApiDoc` (needs the crate's `openapi`
   feature): `#[openapi(components(schemas(scope_capabilities_rust::InsufficientScopeBody)))]`.
2. In the slice's `openapi_spec()`, after the routes are merged, apply the addon
   for the **gated paths** (every method on a listed path gets the 403, so list
   only fully-gated paths):

   ```rust
   use utoipa::Modify as _;
   scope_capabilities_rust::InsufficientScopeResponses::for_paths(["/databases/{id}"])
       .modify(&mut spec);
   ```

   Worked example: `databases-rust/src/http/mod.rs`.

On the **TypeScript** side, mirror it once per boundary so the generated client
decodes the body (and the web UI can name the missing scopes via `scopes-react`'s
`AuthorizationFailure` surface):
import `InsufficientScopeSchema` from `shared-structures-core/http-api-definition`
and attach it with `.addError(InsufficientScopeSchema, { status: 403 })` — at the
`HttpApiGroup` level when the whole group is scope-gated (e.g. gatekeeper's
`/access`), or per endpoint when a group mixes gated and ungated endpoints (e.g.
databases' `DeleteDatabase`, since `ListDatabases` is authenticated-only). Keep
the Rust-documented set and the TS-declared set the same, or the per-slice
OpenAPI drift snapshot test fails. A surface with no `utoipa` documentation (e.g.
gatekeeper's `/access`, which isn't in any committed spec) still returns the 403
at runtime via the extractor — only the TS declaration is needed there.

## What the caller sees: the 403 surface and step-up

Nothing further is needed per slice — the web app already turns a `403` into a
user-facing surface — but it helps to know what the contract buys:

- `wildflower-react/src/router-context.ts` recognises both 403 shapes: a
  **declared** one decodes to `{ error: 'InsufficientScope', missingScopes }`; an
  **undeclared** one arrives as a bare `403` `ResponseError` with no decoded body.
  Either way TanStack Query skips its retries (the token's scopes don't change
  mid-session, so re-sending only delays the surface).
- `renderScopeError` (wired into `ErrorBodyRendererContext` app-wide) renders
  `scopes-react`'s `AuthorizationFailure`, which names each missing scope in plain
  language (`wildflower/Grant.d` → "delete Grants").
- **Step-up:** when the 403 named scopes, the surface offers "Request access",
  which navigates to device login via `buildStepUpTarget(missingScopes, href)`.
  The `?requestScopes=` param pre-fills the scope picker there with those scopes
  **unioned with whatever the caller's current token holds** — the device flow
  mints a whole new grant, so requesting only the missing scopes would strip what
  the session already had — and `?returnTo=` brings the user back to the denied
  page on grant, where the loader re-runs the action against the new grant.
- The current scopes come from `GET /access/session`, which reports back the
  caller's own verified `scope` claim. It is **authN-only** — no `Scoped<…>`
  capability — precisely because the callers who need it are the under-scoped
  sessions arriving from a 403, whom a scope gate would lock out of reading their
  own scopes. When that read fails (a 401 on the plain sign-in path, an older
  server), the screen falls back to its fixed read+search preset, so the endpoint
  is an improvement to the pre-fill rather than a dependency of the flow.

The one thing a slice controls here is whether the missing scopes can be named at
all: declare the 403 (above) and the surface reads them out of the body; skip it
and the user gets a correct but generic denial with no step-up offer.

Because `/oauth/device_authorization` rejects the **whole** request with
`invalid_scope` if any requested scope falls outside the client's `allowed_scopes`,
a gated endpoint that requires a scope the first-party client isn't allowed to ask
for is not steppable-up: the device-login screen names it as unrequestable instead
of putting it in the request. Keep required scopes inside the client's allowed set
(`tauri-shared-config.json`'s `local_granted_scopes`, which seeds them) or the
step-up path dead-ends for that endpoint.

## Three flavours of gate

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
- **Authenticated-only** (gatekeeper's logout and `GET /access/session`): the
  caller acts on their _own_ session and no scope applies — a scope gate would
  lock out exactly the under-scoped callers who need to log out or read their own
  scopes. Implement `AuthenticatedCapability` (`build(state, claims)` receives the
  caller's claims whole) and take `Authenticated<F>` in the handler. It fails
  closed with a 500 when no authN layer inserted claims, like `Scoped`.

## Authority proofs: gating the write, not just the read

Scope gates answer "may this caller reach this data?". Gatekeeper additionally
answers "on what authority is this row being written?" for every privileged
write (approving a request, issuing a code, recording or widening a grant or a
registration, minting a token, issuing a refresh token). Each such write lives
in exactly one **writer** (`gatekeeper-rust/src/domain/capabilities/writers/`),
and each writer method takes a **proof** from `domain/authority/` — a type with
private fields and a single constructor, which is the one function that checks
the rule the proof stands for:

- `AuthenticatedClient` — the client exists, is enabled, and (if confidential)
  presented its secret. Everything a client does on its own behalf takes one.
- `DelegatedScopes` — an Owner's approval clamped to the requested/allowed
  ceiling **and** covered by the approver's own grant, so nothing recorded ever
  exceeds what the approver held.
- `StandingGrantCoverage` — a standing grant covers every scope of a
  _registered_ request: the `/oauth/authorize` fast path's authority to issue a
  code with no human in the loop, named so it can be audited as such.
- `RedeemedAuthorizationCode` / `ConsumedDeviceRequest` / `ValidatedRefreshToken`
  — the redemptions a token is minted under, each carrying the scopes of the
  record it redeemed.
- `HostBootstrap` — the host's own boot-time owner token, the one authority
  with no approving human; constructible only in `seeding.rs`.

Two source guards make it structural: one pins every privileged store method
name to the writers, the other pins the `HostBootstrap` constructor to seeding.
The audit is then the proof constructors plus the writers, not every flow.
Capabilities that no principal unlocks (the pre-auth `/oauth` front door, the
token verifier) are acquired through gatekeeper's `Live<F>` extractor, so a
handler never names the router state; the handler-file guard forbids `State<…>`
and every state field outright.

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
  composition layer beside the state (`crate::live_bindings`), so `domain/` stays
  store-agnostic. The router state itself lives at the crate root
  (`crate::live_bindings::state`), not under `http/`, for the same reason
  (`domain/` builds capabilities from it).
- Owner-UI read models the `GET` handlers return live in `domain/` too (beside the
  capability that produces them), since they're pure data.

## Worked examples

- **Fixed:** `slices/gatekeeper/gatekeeper-rust/src/domain/capabilities/` — the
  `/access` admin surface (`GrantsReader`, `GrantsRevoker`, `ConsentReader`,
  `ConsentDecider`, `TokenRevoker`), generic over `GatekeeperStore`, bound to the
  concrete store in `gatekeeper-rust/src/live_bindings/`. Their privileged writes
  go through the writers under an authority proof (see the section above).
- **Data-dependent:** `slices/databases/databases-rust/src/domain/capabilities.rs` —
  `DatabasesReader` / `DatabasesDeleter`, gated per database by the `read_scope` /
  `delete_scope` the host declares on each `DatabaseDescriptor`, operating through
  the `DatabaseFiles` port (stubbed with an in-memory fake in the unit tests).
- **Authenticated-only:** `gatekeeper-rust/src/live_bindings/session.rs` —
  `LiveSessionEnder` / `LiveSessionReader`, built from the caller's
  `VerifiedClaims` and acquired through `Authenticated<…>`.
- **Authority proofs and writers:** `gatekeeper-rust/src/domain/authority/` and
  `gatekeeper-rust/src/domain/capabilities/writers/`; the flows that obtain a
  proof and hand it to a writer are `domain/capabilities/oauth/` (the pre-auth
  front door) and `domain/capabilities/access/consents/` (the Owner's approvals).
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
- [Splitting Rust Files How-To](../Rust/Splitting%20Rust%20Files%20How-To.md) —
  keeping the source-guard tests here green when a guarded handler file is split
  into a folder.
