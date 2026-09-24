# Review Standards Reference

Recurring PR-review findings, distilled into first-pass rules. The point of this doc is to get these right **before** pushing, not after.

Every PR is reviewed by `ruths-machine` running `/code-review`, and the maintainer (`ruths-machine`'s human, `ruthmarks151`) reads the threads. The classes below get caught on essentially every AI-authored PR — fixing them up front is far cheaper than a review round-trip. If your diff touches any of these surfaces, self-check against the matching rule first.

Testing specifics are out of scope here — see [Testing Reference](../Testing/Testing%20Reference.md) and the `/javascript-testing-expert` skill for how to write the tests these rules ask for. The tests-required rule this doc leans on is in [CLAUDE.md](../../CLAUDE.md) ("Changes MUST include corresponding test updates").

## 1. One source of truth across boundaries

Never hand-copy a constant, formula, schema, or list across the TS⇄Rust boundary or across crates with a "keep in sync" comment. That is a defect, not a convention — the copies drift the moment one side changes. Shared config values go in `apps/wildflower-tauri/tauri-shared-config.json`; shared Rust helpers go in the shared crate; shared TS helpers in kitchen-sink.

> Lets move all these big shared values into `apps/wildflower-tauri/tauri-shared-config.json` — The issuer, the local token scopes, whatever else might be worth sharing. This may require some config passing but that's worth it. (PR #253)

In PR #224 a served-origin formula was duplicated byte-for-byte across two modules, then fed different inputs; a flap fix landed on only one path and the other kept misbehaving.

## 2. A "faithful mirror" claim requires parity tests

Porting a model across languages (e.g. a TS mirror of `scopes-rust`) must ship differential tests: shared fixtures run through both sides and asserted equal. A doc-comment that claims parity proves nothing. PR #266 shipped a TS mirror that diverged in coverage semantics, parse boundaries, and dedupe — silently dropping granted scopes that the Rust side kept.

## 3. Round-trip test wire contracts, including the unhappy shapes

Exercise the producer and consumer of an HTTP/FFI boundary together, not in isolation. Cover:

- **Exact status codes** — a 204-vs-200 mismatch made every successful launch log as failed in PR #258.
- **Empty-vs-absent values** — an empty `subtitle` broke decoding of the entire `GET /apps` catalogue in PR #241, because Effect array decode is all-or-nothing: one bad element fails the whole response.
- **Optionality symmetry** — a field's optionality must match between the read schema and the write schema; a field that can be absent on write must decode when absent on read.

## 4. Tests must be able to fail

A test that cannot fail is worse than no test — it manufactures false confidence. Two anti-patterns shipped repeatedly:

- **Self-referential drift guards** — asserting a constant against a hardcoded copy of itself. PR #239's security-allowlist "drift test" pinned literals rather than reading the TS source, so it would pass no matter how the source changed. A cross-boundary invariant test must derive **both** sides from one source.
- **Stub-the-subject** — mocking the exact behavior the test claims to verify. PR #258's happy-path test stubbed `runAuthed` to resolve, which hid the 204 decode failure the test existed to catch.

New security-critical or lifecycle branches need direct coverage. Reviewers cite the CLAUDE.md tests-required rule by name when they are missing.

## 5. Security ordering and defaults

- **Gate before side effects.** Auth/ownership checks run before any privileged side-effect or existence oracle. In PR #258 the owner gate ran after `resolve_launch_target`, letting a non-owner force `tunnel.try_start()` and probe which launch targets exist.
- **No fail-open defaults.** Do not put `Default` impls on auth types — construct them explicitly so a forgotten field can't silently grant access. Gate test doubles behind `#[cfg(test)]`.
- **Production invariants use `assert!`**, not `debug_assert!` — the latter is compiled out in release builds, so the invariant vanishes exactly where it matters (PR #253). Compile-time checks are better still.
- **Prefer allowlists over denylists** for anything rendered into URLs, HTML, or headers, and reuse vetted helpers instead of hand-rolling partial escapers/parsers. PR #238's `html_escape` missed quotes; PR #240's `safe_host` let through `@`, backslash, `%`, and `?`/`#`.

## 6. Optimistic UI needs rollback and surfaced errors

A mutation with only an `onSuccess` handler leaves the UI silently diverged from the server when the request fails. An optimistic update must:

- Define `onError` rollback that restores the pre-mutation state.
- Render the failure to the user, not just log it. Maintainer: "Also add some kind of banner error display".
- Disable sibling writers while a request is in flight. Maintainer: "Block toggling while the other request is in flight, show it in the ui as disabled toggles". (PR #258)

## 7. Backend atomicity and the async runtime

- **One transaction for atomic validate+mutate.** Enforce invariants like dense/unique positions with database constraints, not application-level checks that race. Maintainer: "Add a UNIQUE(position) constraint AND validate+renumber in one transaction" (PR #258).
- **Don't block the async runtime.** Blocking SQLite or filesystem work inside an async task goes through `spawn_blocking`. Stream large bodies instead of buffering whole files or databases into RAM — PR #228 buffered an entire VACUUM'd database on a tokio worker.

## 8. Naming: match the domain vocabulary, be precise, don't overload

- **Reuse existing verbs.** `evaluateJs`, not a fresh `send`. Use `*Args` for command argument structs, and root packages under `io.wildflowerhealth.*`.
- **Be precise.** The maintainer holds names to their exact meaning: "if `internal_apps_loopback_host` shouldn't have a port use `internal_apps_loopback_hostname` if it should, change it"; "we're consulting the `x-public-origin` — surely this should return an origin rather than a host?".
- **One meaning per variant.** Add a new variant rather than smuggling a second contract through an existing one — PR #241's `AppUrl::External` was made to carry loopback `http` URLs it was never meant to represent.
- **Names carry their context.** A parameter or local names the domain thing it holds, not only its role in the function: "These parameter names (across the whole pr) should communicate more context. This is the pharmacyLocationReference right?" (PR #747). A local holding scopes says `_scopes`; two values of the same kind in scope are named by where each came from (`requested_redirect_uri`, `owner_approved_scopes` vs `registered_client_scopes`); a bare `started`/`starter`/`parked` gets a second word (PR #730).
- **Types are nouns for what they hold, not the moment they were produced.** "A general theme I'm noticing with naming choice across these PRs is having structs representing events, like DeviceAuthorizationStarted that are just a little unnatural and unclear" (PR #723). Event-style results (`DeviceAuthorizationStarted`, `ExchangedToken`), and roles described in the abstract (`ScopeCeiling`, `RegistrationContext`, `MintAuthority`), became `DeviceCodes`, `IssuedTokens`, `ApprovableScopes`, `TokenEntitlement`.
- **Functions name what they do to their input.** `repeatCount` → `asSafeRepeatCount` (PR #747); `choiceElementSetExclusive` → `filterForExclusiveChoiceElementSet` — "this function needs to make it clearer that it's a filter" (PR #748). A name shouldn't read like a test when it performs an action: `start_family_if_granted` "reads like it's running a test rather than reading an object" (PR #722).
- **A bool that encodes a policy is named for the policy** (`registration_is_locked`), not for the identity it is derived from (`is_first_party`) (PR #718).
- **Prefer a type's question-methods over a pass-through accessor** — `client.allows_grant_type(…)`, not `client.client().allowed_grant_types` (PR #720).

## 9. Docs speak in the present tense about the current state

> Revise these docs to only speak in terms of the present state, don't compare to the past. (PR #258)

Before pushing, reconcile the doc comments of every touched module against the diff: command lists, counts, and "what this does NOT do" claims. PRs repeatedly shipped docs that contradicted the code they annotate — including deferred-work notes describing work the same PR had already completed.

## 10. Read config, don't assume

- **Values come from config.** Hosts and origins (e.g. `loopback_host` in the tauri config) are read, not hardcoded: "these are not guaranteed, you need to read config" (PR #241).
- **Extend, don't parallelize.** Add impl methods to the existing store rather than inventing a parallel one: "Don't invent a new store, just add impl methods to the other one" (PR #241).
- **Name the messy expression.** Split dense expressions or extract a named function: "This is really messy, let's name a function for this" (PR #253).

## 11. Types must earn their keep; decode before transforming

- **Check before adding a type.** A method on an existing type or an `Option<T>` usually says it. Rejected shapes: a two-variant enum whose other variant means "don't" ("a confusing half object", PR #718 — became `Option<&ClientRegistrationVerdict>`), parameter bags repeating an existing type's fields (`CodeApproval`, `MintRequest`; `approve_for_code` now takes the `PendingCodeRequest` the flow already has), single-variant error enums ("Does this enum justify itself given it has one member?", PR #730), an enum duplicating an existing outcome enum (PR #722), and anonymous multi-field returns ("This return type is very confusing", PR #747).
- **Decode at the boundary, then work on typed values.** Effect Schema in TS, typed serde structs in Rust. "These parse actions should all be handled with schemas or something. I really don't like this parse in place style"; "These methods should expect values to parse before trying to manicure the data" (PR #747). Carrying `unknown` into the logic and checking `Array.isArray` / `instanceof` along the way is the smell.
- **Transform as `T → T` steps.** "It's weird to hold onto the idea of two indexes for a while because you need them to filter something later" (PR #747) — write each edit as a function from the value to its edited copy and compose them.

## 12. Pre-launch defaults: no compatibility, no swallowed errors

- **No backwards compatibility.** "We're pre-launch. There should be no attempt to maintain compatibility with data from before this pr" (PR #747). That covers stored data, wire shapes between the Tauri host and hosted server, and deprecated aliases after a rename: change the shape and update every reader. Database migrations are the exception: a change to shipped schema or seed data is a new migration, not an edit to one that has already run.
- **Errors bubble.** "Does this ok() swallow an error reading a client? I think that should bubble up as a failure" (PR #730). `.ok()`, `unwrap_or_default()`, and catch-all arms turn failures into plausible defaults; a comment explaining why the swallow is deliberate is the tell.

## See Also

- [Testing Reference](../Testing/Testing%20Reference.md) — how to write the parity, round-trip, and can-fail tests these rules require
- [Doc Comments Reference](../Documentation/Doc%20Comments%20Reference.md) — present-tense and doc-vs-code reconciliation rules for TSDoc
- [CLAUDE.md](../../CLAUDE.md) — the guardrails reviewers cite by name
