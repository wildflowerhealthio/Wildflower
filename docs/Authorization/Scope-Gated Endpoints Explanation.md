# Scope-Gated Endpoints Explanation

Why the scope-gating machinery is shaped the way it is — the reasoning behind
the [Scope-Gated Endpoints How-To](./Scope-Gated%20Endpoints%20How-To.md). Read
this to understand the design; read the How-To to apply it.

## The problem: a permission check you can forget is a permission check you will forget

The obvious way to scope-gate an endpoint is to call a `check_scope(...)` helper
at the top of each handler. That works until someone adds a handler and forgets
the call — and nothing fails, because a missing check looks exactly like code
that was never written. The endpoint ships open. This is the failure mode the
resource-authz work set out to make impossible, not merely discouraged.

## The shape: make the check the price of admission to the store

The machinery inverts the dependency. A data-touching handler cannot reach its
slice's store directly; the only way in is a **capability** — a narrow view of
the store that exposes just the operations one scope authorizes. The single
constructor of a capability is the `Scoped<F>` extractor, and it runs the
covering-scope check _before_ it hands the capability back. So constructing a
capability is itself proof the gate passed: there is no capability-shaped hole a
handler can slip through unchecked, because acquiring the capability _is_ the
check.

Two things make this a structural guarantee rather than a convention:

- **The capability is the sole door.** Handlers take `Scoped<F>`, which derefs to
  `F`; they never see `State<…>` or the store. A handler that wants data has to
  name a capability, and naming it runs the gate.
- **A source-guard test seals the back door.** Rust's module visibility can't stop
  a sibling handler in the same crate from touching a `pub(crate)` store field, so
  a test enumerates the handler files and fails if one reaches the store directly.
  It is advisory-strength (textual, formatting-dependent) — it back-stops the
  "only door" property for the one language-level gap, not the whole guarantee.

## Two flavours, and why the type distinguishes them

Most capabilities are gated by one fixed scope — `GET /access/grants` always needs
`wildflower/Grant.r`. A few are **data-dependent**: which scope a database
download needs depends on _which_ database. The data-dependent flavour can't state
its scope up front, so its static gate is "authenticated only" and the real check
moves inside the methods, against the caller's stored `Grant`.

That inside-the-method check quietly reintroduces the "remember to call it"
problem one level down. Two design choices contain it:

- The flavour is visible in the type. A fixed capability implements
  `FixedScopeCapability` (a non-empty static scope, no `Grant`); a data-dependent
  one implements `Capability` directly (empty static scope, stores the `Grant`).
  You cannot mistake a forgotten scope declaration for a deliberate data-dependent
  one — they are different `impl` lines, and a `FixedScopeCapability` with no
  scopes is a debug-assert failure.
- The per-resource lookup is itself the gate. A data-dependent capability resolves
  a resource id to its record only through one accessor that also proves the scope,
  so a method cannot look a resource up without the check riding along — the same
  "price of admission" property, pushed down to the data lookup.

## Where it lives, and the claims seam

The machinery is the enforcement half of the scope system, so it lives beside the
grammar it enforces (`scopes-rust`), as its own crate `scope-capabilities-rust` —
not folded into `scopes-rust` (that would be a dependency cycle through the shared
`InternalError`) and not in the `shared-structures` grab-bag (which would drift it
away from the vocabulary it belongs with).

Enforcement needs the caller's scopes, which an authN layer must have verified and
stashed first. That seam is a **pair** of middlewares that must stay in lockstep:
gatekeeper's `require_valid_session` guards its own `/access` and inserts the rich
`VerifiedClaims`; `require_valid_bearer_token` wraps the host's downstream slice
routers and inserts the framework-neutral `ScopeClaims`. Both run one shared
verify pipeline, so a token becomes authority the same way wherever it lands — and
because the contract is "one middleware inserts, another reads", it is exercised by
a cross-slice test that drives a real gate into a real capability, not by each side
mocking the other.

## Related

- [Scope-Gated Endpoints How-To](./Scope-Gated%20Endpoints%20How-To.md) — applying
  the pattern in a new slice.
- [gatekeeper Jargon Explanation](../../slices/gatekeeper/docs/Jargon%20Explanation.md)
  — the scope grammar (SMART v1/v2, resources, permissions) the gates check.
