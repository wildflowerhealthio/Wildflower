# Style Guide Reference

How code, designs and PRs in this repository are expected to look, distilled from the maintainer's review comments across the project's pull requests. Quotes are hers. PR numbers point at the thread where the rule was set so the surrounding diff can be read when the rule alone is not enough.

[Review Standards](../Agents/Review%20Standards%20Reference.md) is the pre-push checklist of defects that get caught on nearly every PR. This document is broader: it says what "good" looks like at every altitude, from where a package lives down to how a boolean is named. Read it before designing a change, and check a diff against it before pushing.

The rules alternate between **structure** (where things live, how layers talk) and **lines** (how a given function, type or name reads). Both matter to the maintainer in roughly equal measure; a PR that is architecturally right but reads badly gets the same "changes requested" as one that is tidy but misplaced.

## 1. The reviewer's lens

The maintainer reads a PR by reading its names first, then asking what each new concept is for. Most review rounds are some version of three questions:

- **"What is this, really?"** Vague nouns (`Unit`, `Init`, `Context`, `Core`, `Signal`, `Lease`, `Filing`) get stopped until they can be stated plainly. "The concept of the 'Unit' is confusing, please try and tell me what it really is, maybe there's a better name." (PR #676)
- **"Does this already exist?"** Before any new type, store, helper, runner or constant: is there a FHIR type, an Effect module, an existing store, a kitchen-sink helper or an off-the-shelf crate that already says it? "This seems to be inventing a lot of concepts that already exist." (PR #712)
- **"Can this be simpler?"** "Seems good, but I want to hunt for simplicity." (PR #1219) Every mode, flag, wrapper and indirection must justify itself. "Is all this indirection and state justified?" (PR #48)

Write with those three questions in mind and most review rounds disappear.

## 2. System design

### 2.1 Where code lives

- **Slices are vertical, layered and pure at the core.** `<name>-core` is the pure layer; adapters depend on it, never the reverse. Logic that does not need React or a platform belongs in a core package, not the React one: "A lot of the logic in here should exist in a pure TS package, rather than the react one." (PR #676) See [slices/AGENTS.md](../../slices/AGENTS.md).
- **Generic helpers go to `kitchen-sink`; FHIR helpers go to `fhir-r4`.** `pad2`, `stripTrailingSlash`, `unknownErrorToString`, hash functions, `NonBlankString`, `useContextOrThrow`, `NoContextException`, `makeSubscribableStore`, test logging layers: all were asked out of slices and into the global packages (PRs #58, #82, #112, #201, #476, #607, #752). Quantity arithmetic, `.empty` values, URL conventions and date search parsing belong in the relevant `fhir-r4` namespace (PRs #381, #443, #752, #1149).
- **Code used by one product lives with that product.** "This isn't shared, I think this slice should move into the app folder of the website." (PR #1281) Source-specific code lives in its source package: HAR code in the HAR package, Rexall code in the Rexall package (PRs #381, #631, #797).
- **A package does one job and mirrors its siblings' shape.** A crate named `emr-rust` that only did FHIR R4 setup became `fhir-r4-rust` to match the TS split (PR #146). New Rust slices were told to "follow the patterns established in Gatekeeper-rust as exactly as possible" and to lift shared database utilities into a common crate (PR #177). Read the neighbouring package before designing a new one.
- **Layering is enforced by dependency direction.** "Effect-messaging MUST NOT import from the slices. Something needs to get moved or reconfigured." (PR #23) A host adapter must not depend laterally on the React adapter (PR #149). Fix the placement, not the import.
- **Apps compose; they hold no business logic.** Launch-target resolution, click-handling policy and bridge logic were pushed out of the app and into the server or the slice (PRs #48, #232).

### 2.2 One source of truth

- **Shared values are read from one file.** Issuer, scopes, ports and origins live in `tauri-shared-config.json` or `dev-app-ports.json` and are read by both languages. "Lets move all these big shared values into tauri-shared-config.json." (PR #253) A port pinned in two languages with a comment tying them together is a drift hazard (PR #149).
- **Mirrors need a drift test or they are not mirrors.** A TS copy of a Rust model, two `TABS` arrays, two origin formulas: either derive both from one source or ship a test that fails when they diverge (PRs #160, #224, #266).
- **Derive, don't redefine.** Types come from schemas: "There's still a few type definitions left in this file, do ANY have a schema they could be referencing? If so, replace the definition with one derived from the schema." (PR #19) Route paths come from the generated route tree, not a hand-typed union (PR #160). Message-handler types come from the bridge message schemas "so they're unable to drift" (PR #29).
- **Read config; never assume.** Hosts, origins and loopback addresses come from config. "These are not guaranteed, you need to read config." (PR #241)

### 2.3 Extend, reuse, borrow

- **Extend the existing piece rather than adding a parallel one.** "Don't invent a new store, just add impl methods to the other one." (PR #241) When a ticket proposes new machinery but a matching piece exists, extend it; the codebase beats the ticket.
- **Prefer the platform's own tools.** Effect Platform for file reads and servers (PRs #23, #48, #84), Effect `Encoding` over `Buffer` (PR #15), the Tauri dialog plugin over a hand-rolled one (PR #149), the rathole `Config` structs over a rendered TOML string (PRs #177, #924, #1011), `toml::to_string` over string formatting (PR #177). "Is there a rust-conventional choice to use for this rather than hand rolled?" (PR #177)
- **Off-the-shelf before custom, even for names.** "Thinking bigger, is there an off the shelf solution that can handle some of this? Or at least that we can borrow names from as needed." (PR #1001) The server runner was reshaped around an axum-like service rather than a custom runner.
- **Ship the simplest fix first.** When a bug has several candidate fixes, land the smallest one that addresses the diagnosed cause; offer the rest only if the bug survives. A speculative extra PR was rejected as "complex and didn't solve the problem" (PR #880).

### 2.4 Boundaries and layers

- **Rust slices: pure domain actions, a thin store, adapting handlers.** The store is a trait over simple CRUD on domain types; domain actions use the store and hold the logic; HTTP handlers only transform wire input, call the action and transform the output. "This logic is all domain material, these handlers should just transform HTTP styled inputs, call domain functions, and transform the output. please apply this principle to all of the HTTP handlers." (PR #356) Richer logic found in a store method is lifted to the domain (PR #356).
- **Policy sits at the edge, not inside helpers.** Who may connect is middleware's job, applied at the server level; a path helper or an origin reader must not also test for loopback peers (PR #125). Auth middleware is applied where routes are mounted, not baked into a slice's API definition (PR #30).
- **Effect code takes its dependencies from the context.** Services, the clock and the store come from the Effect context, not parameters: "You're returning an effect! use context for this, not a parameter." (PR #19) Every `Date.now()` and `unsafeNow` became `DateTime.now` from the context "for easier testability, even if that means some functions need to start returning effects" (PRs #19, #125).
- **Polymorphism stays out of the store.** Writes take the concrete kind; choosing which table to write is domain logic (PR #356). An app is an `AppRegistration` (common to all kinds) paired with a per-kind `AppConfiguration`; the "NewCloudApp is a fiction that the HTTP layer transforms before calling a domain layer action" (PR #355).
- **Decode at the boundary.** Bodies are parsed by the route definition, not by hand in the handler (PR #19). Responses are declared on the API definition, "rather than unsafe JSON here" (PR #19). See [Review Standards §11](../Agents/Review%20Standards%20Reference.md#11-types-must-earn-their-keep-decode-before-transforming).

### 2.5 HTTP and resource design

- **APIs are resource-shaped.** `/installed-apps/:id`, not an action verb; a PATCH on the field being changed, not a bespoke enable/disable endpoint (PR #736); a `PUT /home-screen` with the full ordered array so ordering is atomic and well-formed (PR #258). "Don't use this shape of API, have a resource based API that gets PATCHed on the enable field."
- **Disable-with-timestamp over boolean toggles.** Disabling sends a UTC instant the server clamps to now; enabling sets it to null (PR #736).
- **Page routes use `/view`**, never `/ui` or `/page` (PR #19).
- **Match the RFC's vocabulary.** "Is 'flow' the term used in the OAuth RFCs? I want to match them fairly exactly." (PR #19) "Out of band" became "device flow". Return the error code the spec names (`invalid_grant`, not `invalid_request`) and the headers it requires (PR #149).
- **Status codes are exact and declared.** A 404 is a 404 (PR #28); a client declares the 204 and 302 it accepts (PR #258).
- **Trailing slashes are faults.** Audit route tables and exemption lists for them and fail if present (PR #253).

### 2.6 Pre-launch defaults

- **No backwards compatibility.** Change the shape and update every reader; no fallbacks, dual reads or deprecated aliases. Database migrations are the exception: add a new one. (PR #747)
- **Delete, don't deprecate.** Dead code, dead modules, empty exports, stale `TODO.md` files and drifted design docs are removed in the PR that makes them dead (PRs #14, #15, #39, #122, #718, #1000). "This is on an epic branch so I'm ready to break things for a while." (PR #1000)
- **YAGNI.** Fields and columns "if they're truly required add them later" (PRs #177, #223).

### 2.7 Security and safety defaults

- **Loopback by default, redundantly.** Bind to `127.0.0.1`; additionally fail and log any request that is neither from loopback nor carrying the expected forwarded header (PRs #9, #149, #241).
- **Gate before side effects; no fail-open defaults; production invariants use `assert!`.** See [Review Standards §5](../Agents/Review%20Standards%20Reference.md#5-security-ordering-and-defaults).
- **Crash on the impossible; never default it.** "If there's no byte, surely we should crash or try again not default to zero?" (PR #19) A missing SOP class is a parse error at the header, not `?? ''` (PR #712). Migrations that fail must fail, "this shouldn't default to 0" (PR #181).
- **Panicking is the caller's choice.** Library functions return `Result` or `Option`; they do not `expect` (PRs #232, #355, #1293). Inside a transaction, "fail with a result so the transaction rolls back" (PR #355).
- **Mutual exclusion is explicit and brief.** Shared maps are edited under one lock (PR #10); "spend as little time locked as possible" (PR #177); prefer `BEGIN IMMEDIATE` transactions when a read decides a write (PRs #355, #356).
- **Secrets and data residency.** Client secrets are stored with a slow salted KDF (PR #149). Hosted pages do not reach the LAN; loopback targets stay allowed (PR #1147). Large assets ship as files, not strings compiled into the binary: "this is just very foolish. you must include the file as an asset, not keep it in memory forever" (PR #324).

## 3. Modules and files

- **Namespace-style modules.** One concept per file, exported as a namespace: `Schema`, `Type`, `make`, predicates and operations inside it, read as `HarSelection.make(...)` or `TrainingPlanDefinition.Day.Schema`. "This file should expect to be used as a namespace, `DomainResourceUpsertEvent` => `DomainResource.UpsertEvent`." (PR #14) Inside the file use the fully qualified name; export the short one meant to be read through the namespace (PR #752).
- **No abstract classes; no `Schema as ES`; no brands.** Abstract classes became "a namespace with a type and a make" (PRs #28, #19). `import { Schema as ES }` is banned (PR #14). Branded id schemas were removed everywhere "for the sake of ergonomics" (PRs #19, #28, #30).
- **Split busy files along concepts.** A long handler file becomes a folder where "routes/functions that need the same helper methods stick together" (PR #19); one route per file with the file path mirroring the route (PR #149); one domain action per file with its args struct beside it (PRs #355, #356); a `domain/` folder and a `commands/` folder (PR #1001). A file of loose exports becomes "a folder of namespace-minded files, probably grouped by the resource types they deal with" (PR #112).
- **Colocate route-only code with its route.** Files used by one route sit next to that route file (TanStack `-helpers` style), not in a shared `src/` (PR #1270). Wire types used by one route are declared in that route's file; only those shared by several live in `http/wire_representations.rs` (PRs #355, #356). A helper used in one place is inlined or moved to its one caller (PRs #41, #405).
- **Avoid barrel files.** "Define code in a logical file and collect those exports in the named index." (PR #15) Re-exports are replaced with direct imports (PRs #181, #543, #843). Don't re-export a module's contents alongside the module itself (PR #843).
- **Index files that are getting busy are a signal**, not a fact of life: introduce a sub-entry (`importer-fundamentals/something`) or a namespace to lighten the load (PR #676).
- **Non-test code sits above the test block** in Rust files (PR #730).
- **File names tell the truth.** `tab-mapping.ts` with no mapping becomes `tabs.ts` (PR #160); `page-error.tsx` that renders a body becomes `page-body-error.tsx` (PR #126); `download.rs` that takes an id becomes `download_by_id.rs` (PR #353).
- **Sibling concepts share a folder with an index.** "Make a human name folder, so the files are all siblings. Have an index with the exports." (PR #1149)

## 4. Types and data modelling

- **Start from the FHIR resource and narrow it.** No parallel domain types with `toFhir`/`fromFhir` adapters. Define a schema that decodes a parsed `fhir-r4` type into a narrowed extension guaranteeing the required data, and export getters. "Pass around a FHIR object and have getters for these fields." (PR #752) A domain-specific medication representation "that duplicates so much from the fhir-r4 package" is a smell (PR #747).
- **"Could this be schema code?"** Range checks, exactly-one lookups and all-or-nothing readers are `Schema.filter`, `transformOrFail` or refinements, not helper predicates. "This whole PR needs an audit for 'could this be schema code?'" (PR #752) A bidirectional encode/decode pair "should be assembled into a complete schema that fails as one expects for a schema" (PRs #381, #445).
- **Parse before manicuring.** "These methods should expect values to parse before trying to manicure the data." (PR #747) `unknown` plus `Array.isArray`/`instanceof` checks inside logic is the smell; chained conditions become schema decodes (PR #413).
- **Mandatory when the data has it.** If a stored archive really carries a subject, the field is mandatory on the type; optionals are not a way to defer modelling (PR #712).
- **Model cases as unions, not optionals.** "This seems to me like two (maybe 3?) cases, please use an enum of cases instead of all these optionals." (PR #333) `EditorState | null` becomes a tagged union in a namespace (PR #620); a discriminated union of props over boolean flags (PR #8); `Data.TaggedEnum` for state (PR #271).
- **Options, Eithers and named failures over null.** An `Option` where a value may be absent; an `Either` with named failure cases where null "has a lot of semantics" (PRs #1167, #1168, #506). Return `Either` rather than a sentinel string so the caller can show the error (PR #23). Use `?? null`, never `orUndefined` (PR #39). Distinguish unknown from decided state with `null | boolean` only when the third state is real (PR #11).
- **A new type must earn its keep.** Suspects: single-variant enums, "confusing half objects", parameter bags that repeat an existing type, anonymous multi-field returns, enums mirroring one that exists, `ListEntry` types that are just the entity (PRs #314, #718, #722, #730, #747). "Does this app struct do anything at all?" (PR #355) See [Review Standards §11](../Agents/Review%20Standards%20Reference.md#11-types-must-earn-their-keep-decode-before-transforming).
- **Args structs and object parameters.** Several same-typed positional parameters are a transposition hazard: take a labelled object in TS (PRs #113, #752, #1258) and an `*Args` struct in Rust (PRs #149, #238, #355, #1219). Store methods take args structs "where the names match up with the return object types" (PR #355). Tuples with meaning get named fields (PRs #304, #1033).
- **Newtypes convert, never expose `.0`.** `JsonColumn`/`UriColumn` implement `From` both ways "so this doesn't have a magic `.0`" (PR #149). A `From` impl beats a `*_from_row` function (PR #355). A bool with a policy meaning may be a newtype with a clear default (PR #730).
- **Time is typed.** Effect `DateTime` and `Duration` in TS, never numbers of seconds or JS dates (PRs #19, #22, #29, #104, #125, #444); chrono/`Instant` types in Rust rather than `i64` claims (PR #149). Formatting goes through Effect "so the style is handled globally and deterministically" (PR #22).
- **Numbers on the wire are finite.** `Schema.JsonNumber`/`Schema.finite()`; `Schema.Int` where the value is a count; `Schema.NonEmptyString` where emptiness is not meaningful (PRs #27, #30, #131). Prefer Effect's built-in schemas (`NonEmptyTrimmedString`) to custom ones; use standard codes (UCUM) directly (PR #752).
- **Nullable means nullable.** `OptionalId` that is really null became `NullableId` (PR #14). Decide at the schema level whether a column is nullable and test it (PR #19).
- **Empty collections are empty, not `None`.** "Should this just allow an empty vec rather than none?" (PR #149)
- **Make the type system carry the fact.** A `DocumentReference/${string}` template literal, a `satisfies Schema.Schema<Row, any, never>` on every wire schema that decodes to a row ("otherwise I don't trust them"), a generic on the key union rather than `TSettings, TReview` (PRs #19, #640, #676). Prove a property structurally rather than asserting it (PRs #27, #91).
- **Enum what is finite.** A `method` column "actually got a finite set of values" and so is an enum (PR #19); a named enum schema rather than inline literals (PR #14); a multi-value `Schema.Literal` rather than a union of singles (PR #70).

## 5. Naming

Naming is the single largest category of review comments. The principles, with the examples that set them:

- **Name for purpose, not metaphor.** "Lease" became "keep-alive" because the reviewer could not tell what a lease was for (PR #1005). "Lease gained is an entirely unclear term." Names like `Core`, `State`, `board`, `signal`, `drive`, `caller`, `member`, `unit`, `slot`, `Init`, `Filing`, `ArchiveLinks` all drew "what is this, really?" (PRs #28, #397, #686, #712, #1005, #1027).
- **Names carry their context.** A local reads correctly with the signature out of view: `pharmacyLocationReference`, not `reference`; `serviceRequest`, never bare `request` ("Request means SO MANY things in software"); `exerciseSetObservations`, not `setObservations`; a variable holding scopes ends in `_scopes` (PRs #718, #747, #752).
- **Two of a kind are named by origin.** `requested_redirect_uri` vs `registered_redirect_uri`; `owner_approved_scopes` vs `registered_client_scopes`; `initial_config` (PRs #730, #945). `starter`/`started`/`parked` each need another word (PR #730).
- **Types are nouns for what they hold.** Not the event that produced them: `DeviceAuthorizationStarted` → `DeviceCodes`, `ExchangedToken` → `IssuedTokens`; not abstract roles: `ScopeCeiling` → `ApprovableScopes`, `MintAuthority` → `TokenEntitlement` (PRs #718, #723). "I think this needs a name that refers to a noun." A type must not read like the thing that runs: `CertificateRun` → `ObservedCertificate` (PR #1029).
- **Functions say what they do to their input.** `repeatCount` → `asSafeRepeatCount`; `choiceElementSetExclusive` → `filterForExclusiveChoiceElementSet`; `parsePathToAssetFile`; `try_split_subdomain`; `ensure_some_signing_key`; `deleteAuthorizationRequestsExpiredBefore(expiredBefore)` (PRs #19, #23, #149, #241, #747, #748). A name "shouldn't read like it's running a test rather than reading an object" (PR #722). A getter is `getEnabledClient` with a return type that says so (PR #19).
- **Split the fact from the decision.** "In use" became `open` (the fact) and `open_or_in_grace` (the decision) (PR #1005). A bool encoding a policy is named for the policy (`client_disallows_runtime_edits`, `registration_is_fixed`), not the identity it was derived from (`is_first_party`) (PR #718). "What does first party mean? I'll probably learn later?" (PR #690) is the sound of a name that leaks a decision.
- **Tense matches timing.** A flag telling the caller to act is `unit_restarts_needed`, not `running_units_restarted`; `entered_grace_period_at`; `in_use_after_event` for a temporal event (PR #1005). A name must say which side of a restart it is on.
- **One meaning per word, and no collisions with neighbours.** `enabled` clashes with a run policy's always/off; `lock` "makes me think mutexes"; `kind` is the project's discriminator word; `archive` and `unit` were questioned everywhere they appeared; `denied` vs `declined` must be harmonised (PRs #19, #396, #667, #1005, #1141). Ambiguous imports get a qualifying prefix: `TauriBackgroundServiceStopReason` (PR #1005).
- **Split catch-all variants by cause.** `StoppedByRunner` → `Replaced` / `Removed` / `PolicyInactive` / `StoppedForRestart` (PR #1005). A word true of several siblings is wrong for one of them: `Validity::Valid` → `NoRenewalNeeded`, because `RenewalDue` certificates are valid too (PR #1029).
- **Be literal about the kind of string.** A `string` field says whether it is an id, a reference or a name (PR #752). `hostname` has no port; `host` may; `origin` has a scheme; a function consulting `x-public-origin` returns an origin, not a host (PRs #240, #241). A URL value is a `URL`, "lets go even further with the urlifying" (PR #258). Loopback things say loopback in their name (PR #149).
- **Prefer the domain's own vocabulary.** `ExerciseRequest` (a ServiceRequest whose service is an exercise), `ExerciseSetObservation`, `WorkoutDefinition`, `ImportedDocumentReference`, `StudyFileSet`, `AccessManagement`, `RelatedSubjects` (PRs #22, #676, #712, #752). "Set result sounds like empty programming words." Match RFC terms exactly (§2.5).
- **Channels and handlers follow fixed suffixes.** Rust channel ends are `_tx`/`_rx` (`visitor_stream_tx`, `shutdown_request_rx`, `local_owner_token_tx`) (PRs #149, #924, #1001, #1011). React handlers are `handleX`, not `onX` (PR #48). DOM ids are `codeInputDomId` (PR #191). Defaults say `default` (PR #48). Test constants say their role: `HANG_TIMEOUT`, `QUIET_PERIOD`.
- **Expand abbreviations.** `RT` → `ResourceType` (PR #14); JWT claim fields keep long readable names and serialise to the short form (PR #149). Wordy is fine; vague is not.
- **Name the messy expression.** A dense `if let` chain, an arcane boolean, an opaque computation: "This is really messy, let's name a function for this" (PR #253); "lift out and name the thing you're matching on" (PR #1253); "name rounding error and the determining boolean" (PR #1173); "Generally try to explain your goals and methods with variable names, as is, the math is a little arcane" (PR #1173). Applying De Morgan and naming the result turned a suspected bug into obviously correct code (PR #1005).
- **CSS classes follow BEM**: block is the component file in kebab-case, `block__element`, `block--modifier`, read as `styles['tab-bar__tab']` (PRs #22, #30, #160, #686). Routes name their access tier: `openRoutes`, `authenticatedRoutes`, `settingsRoutes`, not "flow" (PR #49).
- **Packages**: npm `@wildflowerhealthio/<folder>`; crates `wildflowerhealthio-<folder minus -rust>`; Rust crates `-tauri`, TS `-tauri-js`/`-tauri-react`; product names are "Wildflower …" followed by the app name (PRs #1042, #1053, #1281).

When a review asks "what is this for", answer with a rename table (old → new → why) rather than a prose defence; the #1005 rename proposal was approved wholesale on that basis.

## 6. Control flow and Effect style

### TypeScript

- **Pipelines of named steps.** A handler body reads as a series of comprehensible function calls; "every one of these possibly erroring test steps should be their own function with a good name" (PR #19). Early returns become named effect functions. Mixing `Effect.gen` inside a `pipe` "feels awkward": pick one (PRs #19, #82). Too much nesting means "make use of pipe()" (PR #125).
- **`Match` for mutually exclusive cases.** Double ternaries, switch chains, status branching and final returns use `Match.value`/`Match.type` (PRs #19, #41, #318, #607, #631, #654, #676, #1016, #1270). An exhaustive match "fails if a new kind is added" (PR #1175). Many ternaries on one flag means "split into larger cases" (PR #1296).
- **Effect's data modules over hand-rolled loops.** `Array.groupBy`, `Array.partitionMap`, `Array.filterMap`, `Array.dedupe`, `Array.findFirst`, `Order`, `Option.getOrder` with no sentinels (PRs #515, #641, #712). "This file is rich with things that might be clearer if you used Effect's Array module." Prefer a `Stream<Either>` to a tower of pipes (PR #396).
- **Options in JSX**: `opt.pipe(Option.map((v) => <p key="…">{v}</p>), Option.getOrNull)`; never `Option.isSome` ternaries or `Option.match` with inline components (PR #888). "This is hard to read, rewrite it with optionals." Inside an existing pipe use `Option.filter`/`Option.map` rather than re-wrapping (PR #1033).
- **Errors are values that surface.** Promise error handling becomes "one big effect" (PR #631). A fetch that returns empty on failure becomes an Effect whose failure the UI shows (PR #682). Fault-tolerant fan-out logs each failure with `Effect.logError` rather than letting one block the rest (PR #74).
- **Logs have levels.** `Effect.logDebug`/`logWarning`/`logError`; `console.*` only through a leveled bridge (PRs #68, #125). A log on a known-unlikely branch beats silence (PR #48).
- **`Effect.die` for the impossible**, a typed failure for everything else (PRs #9, #19).
- **Layers compose; providers don't pre-provide.** Merge layers before providing; don't bake a runtime into a client object: a layer that provides the client is what gets shared (PRs #26, #42, #48). A `Layer` is for a long-lived service; a one-off seed is "a function returning an effect that I can call after the store is available" (PR #19).
- **Hooks take a layer**, not a runtime, when the pattern repeats (PR #29). Logic in a component "should be a single hook" when it is one computation (PR #48).
- **No `{ replace: true }` navigations** unless there is a reason the page must vanish from history (PR #49). Navigation is a thrown redirect, not a rendered component (PRs #304, #1277).

### Rust

- **Iterators over premature collection.** "Just return an Iter? avoid premature collection of sequences that will be consumed later." (PR #149) `any` over `collect` + `contains`.
- **Struct-update syntax**, not `let mut x = Default::default(); x.a = …` (PR #146). Destructure at the top of a function so moves are explicit (PR #146).
- **Visibility is the minimum.** `pub(crate)` unless something outside needs it; "How are these used, do they need to be pub? Examine this across the board." (PRs #149, #181) `#[must_use]` on functions whose result matters (PR #177).
- **Modules export under their own name.** `pub mod sql_builder`, read as `response_templates::internal_error`, rather than flat re-exports: "It's much clearer to read `response_templates::internal_error` and know its about generating a template." (PRs #149, #181)
- **Borrow where you can.** "Could the state be passed by ref?" "Do I need to clone the handle?" "Does the extensions in arc require the arc?" (PR #149) Ask these before adding `Arc` or `clone`.
- **`RETURNING` over read-back**; one query over read-modify-write (PRs #177, #355).
- **Async discipline.** Blocking work in `spawn_blocking`; stream large bodies; read just the head when that is all that is needed (PRs #228, #921). Bounded timers and disposal on anything that waits (PR #429).

## 7. React, UI and product

### Structure

- **CSS modules with BEM, built on tundraish.** Per-component modules, BEM names, the existing CSS variables and shared classes; "Do as much styling as you can with tundra and react-tundraish" (PRs #22, #30, #199, #454, #686). Shared elements (fields, loaders, error pages, avatars) belong in `react-tundraish`, not a slice (PRs #41, #48, #304, #746). A page padding variable, not per-page padding (PR #199). Breakpoints switch together (PR #1252).
- **Components speak the domain.** A consent form "needs to become a folder of several things with components that speak the domain" (PR #304). Lift repeated JSX into a component (PR #22); lift page wrapping into the route component when every page uses it (PR #112).
- **Page logic lives in a page hook declared beside the page**, "so that it and the UI can be examined independently" (PR #1270). Pure logic goes further down, into core.
- **The router owns navigational state.** Tabs are child routes, not a query param (PR #1252); links are `<Link>`s and switching is handled by the router (PR #1118); file-based routing where the app has it (PRs #1140, #1270); a value tied to the route is read from the router or passed as a prop, not stuffed in a React context (PR #1270). Every page that needs a patient has the patient in its URL (PR #1277).
- **Minimise wrappers.** "Is every single div/span needed?" (PR #8) A hook that renders nothing must not render an empty div (PR #888). A body component is a fragment so the container's styles apply (PR #126).
- **State over refs**, unless something genuinely must be a ref (PR #128). Updater-function `setState` when the next state depends on the previous (PR #783).

### Behaviour

- **Mutations are honest.** Optimistic updates roll back on error, errors render in a banner, sibling writers are disabled while a request is in flight (PR #258). Don't clobber a user's dirty field on an unrelated revision bump: "If the state on server hasn't changed for a field, don't replace it, is a general rule." (PR #191)
- **Errors and notes go above the buttons, full width.** "I never want to see a message below the buttons." (PR #1095) "Please use the full width above that button to display any error or info." (PRs #1162, #1270) Each fact has one wording in one place; an action's reason never restates a status shown nearby.
- **Do both, not a mode.** Show a button for folders *and* a button for files; always render the multipicker; "Rather than a mode, I think we should always have a great multipicker." (PR #712)
- **Infinite scroll, not "Show more"**, matching the other apps (PR #712).
- **Safe areas and notches are real.** Banners and content sit inside the dynamic padding (PR #888).
- **Prefetch so first paint has data**, "hiding the web app nature of these pages" (PR #121). Use a redirect that avoids a flash rather than rendering a transient page (PR #304).
- **Status is served, not polled.** Manual refresh until a live stream exists; health comes from the server's `/health`, not a separate status slice (PRs #980, #1000, #1004).

### Copy and product sense

- **Think like the product owner.** "Maybe just 'Delete from my device' with a 'this doesn't necessarily remove information this app has stored', idk, think about it as a product owner." (PR #318) Settings get a reassuring explainer under them ("Some apps need to access your health data over the internet to work.").
- **Labels are literal and consistent.** "Apps" on the home button and "app launcher" in settings (PR #1270); "Wildflower Medications", "OHIF Imaging Viewer" (PR #1281); Title Case for titles, `Authorize a Device` (PR #125); names with ids, not ids alone, because "Client IDs are random and opaque" (PR #1140).
- **Describe a FHIR server, not a device**, in user-facing language about data sources (PR #506).
- **Borrow familiar interaction design.** iOS home-screen rearrange for reordering (PR #318); a tabs-style picker when switching forms (PR #318); a closed eye for anonymise and an open eye for dismiss (PR #632); the URL under the title in a webview chrome (PR #238).
- **Dark and light mode use the app palette** across every native webview chrome (PR #238).

## 8. Comments and documentation

- **Comments are TSDoc that is useful on hover, or an explanation of why.** "Try to pare them down to either informative tsdoc that's useful on hover or explanation of the why of the code. Remove anything that can be found by reading the module." (PR #23) "This whole file has outlandishly too many comments. Delete everything that isn't genuinely surprising from reading the code." (PR #104) Audit with "Would this be useful on hover? If so, make it a TSDoc." (PR #125)
- **Move framing into docs.** A file with paragraphs of architecture becomes an `Explanation.md` plus quick-reference comments (PR #208). Doc comments describe what the symbol holds, not a narrative about a different function (PR #149).
- **Move understanding into names.** "The variable names in this file are unclear, try to move the understanding from the comments into the variable names." (PR #128) A comment that explains a swallow or a default is a signal to fix the code instead.
- **Docs speak in the present tense about the current state.** No comparisons to the past, no "removed X and why" tables, no changelog narration in a doc comment (PRs #160, #258, #818). Delete docs about code that no longer exists (PRs #122, #208, #316, #356).
- **The PR body is not the spec.** "Ignore the PR description, verify that the code and comments are correct." (PR #429) Reconcile every touched doc comment against the diff before pushing.
- **Entities get a one-line doc on their role in the flow**: "This and methods like it need a doc comment explaining the entity's role in an auth flow." (PR #19) Structs with cryptic fields get brief doc comments (PR #149).
- **Jargon gets a definitions doc.** A `Jargon Explanation.md` for Challenge, Grant, issuer, audience (PR #19); a `Capability Statement.md` listing known gaps in FHIR conformance (PR #15); a `Packages Explanation.md` note when a crate's naming diverges (PR #146).
- **Explain the deliberate oddity in one line.** Why the transmitted field is snake_case, why `-0` is excluded, why a sniffer cannot use the shared schema, why a `Reference.type` is a plain string (PRs #10, #15, #131). Caveats the maintainer chooses to accept are documented, not fixed (PRs #410, #476).
- **Lint clean.** `vp run lint:docs` and `vp run lint:comments` are clean before pushing; escape braces in comments (PRs #43, #113, #122).

## 9. Tests

The testing docs say how; this is what the reviewer expects to see.

- **Property-based first.** Round trips, codecs, parsers, sniffers and concurrent capture are property tests over `Arbitrary.make(Schema)` or proptest (PRs #15, #27, #70, #149, #381). "Make this actually property based." An arbitrary that efficiently guarantees compliant values beats filtering (PR #28). Explicit filtered cases show the limits of a lossy conversion (PR #381).
- **Whole-value assertions.** Compare the entire decoded object, claims set or JSON body in one `assert_eq!`/`toEqual`, passing dynamic fields through from the actual, so a diff names every wrong field and nothing goes unpinned (PR #149). Expectation helpers match `{ _tag: 'Right' }` so the whole object is logged on failure (PR #28).
- **Tests must be able to fail.** No self-referential drift guards, no stubbing the subject, no negative assertions that pass when the code grows an extra hop: "anchor the absence to a presence" (PR #149). See [Review Standards §4](../Agents/Review%20Standards%20Reference.md#4-tests-must-be-able-to-fail).
- **Deterministic over sleeps.** Named timeouts and quiet periods; allow for uncertainty in timing-dependent values (PR #149); use the kitchen-sink logging layer to assert on logs rather than silencing them (PRs #28, #78).
- **In-memory stores for DB tests**; an always-allowed fake for a DI requirement rather than a whole in-memory SQL DB "feels overdone" (PRs #149, #333). Test doubles behind `#[cfg(test)]`; shared test helpers in a `test_utils` module or a `/test` export (PRs #78, #241).
- **Cover the security branches and the happy path end to end.** Wrong verifier, expired code, double redemption, pending/slow_down/single-use (PR #149).
- **Don't over-test UI.** "Add some tests for all these. Don't worry about exhaustively covering ui behaviour though." (PR #11) Manual testing is acceptable when the behaviour lives in a native handler, but automated is "most preferred" (PRs #239, #429), and a manual test plan is written down.
- **Tests import from the index under test** and live beside the code (PRs #266, #28).

## 10. Working with the maintainer

- **Discuss the plan first; mirror existing structure.** Pre-read neighbouring packages, propose the shape, then build. "Verify that plan with me." (PR #676) When a concept needs a noun, propose it before coding around it (PR #1001).
- **Reply, don't dismiss.** "Reply here with your plans. Don't dismiss this comment." (PR #19) Questions in review are genuine ("Help me understand", "genuine question, I may be off here"); answer them with evidence from the code, and say when the reviewer is right that something is unneeded (PR #713).
- **Do what the comment says, across the whole PR.** "Apply this principle across this project." "Audit the whole PR for date code that should use effect." A fix to one instance of a pattern is expected everywhere the pattern occurs (PRs #19, #29, #607).
- **Review comments carry an analysis, then emoji-tagged action options.** 🎉 / 🚀 / 😕 / 😄 each introduce one concrete action; two independent actions get two tags (PR #33).
- **Small PRs, one concern each.** A fundamentals change and a source-specific change are two PRs (PR #797); risky refactors land "in an independent rollback friendly commit" (PR #112); suggestions are "isolated into individually readable commits" (PR #191).
- **Push sooner.** Run the tests that cover the change, `vp check` the touched paths, push, and let CI catch the rest. No full-suite reruns for certainty.
- **Deferred work becomes a ticket, not a comment.** "Create a GitHub issue about this, I agree, but not right now." (PR #15) Caveats worth retaining go to a named doc (§8), not a TODO.
- **Rebase onto main and resolve conflicts carefully**; don't revert others' recent changes in the process (PRs #65, #201, #733).
- **Ask when guessing.** Three investigative actions without converging, two plausible interpretations, a workaround for something that looks accidental: stop and ask. Err on the side of asking.
- **Draft vs ready, assignment, and the review loop** are in [CLAUDE.md](../../CLAUDE.md#pull-requests-drafts-and-assignment).

## See Also

- [Review Standards Reference](../Agents/Review%20Standards%20Reference.md) — the pre-push defect checklist with PR evidence
- [Effect Patterns Reference](../Effect/Patterns%20Reference.md) — the Effect idioms this guide assumes
- [Testing Reference](../Testing/Testing%20Reference.md) — how to write the tests §9 asks for
- [Doc Comments Reference](../Documentation/Doc%20Comments%20Reference.md) — TSDoc conventions behind §8
- [Page Headers Reference](../UI/Page%20Headers%20Reference.md) — the launcher's page header rule
- [slices/AGENTS.md](../../slices/AGENTS.md) — slice layering and placement
- [CLAUDE.md](../../CLAUDE.md) — the guardrails reviewers cite by name
