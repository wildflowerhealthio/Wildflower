# Plan: Dissolve `Source`, make `HttpResponseKind` first-class, per-URL importer + file-format framework

## Context

`HttpResponseKind.isFoundAt` (a URL predicate), `Source.rootOf` (reads a resource's server root off a URL), and `Source.specificity` (ranks which source claims a capture) are three reads of **one** idea — and today the FHIR source literally writes the recognition pattern twice: `UrlMatch.make(...)` for `isFoundAt`, and a parallel hand-written capturing regex (`PATIENT_ROOT`/`OBSERVATION_ROOT` in `fhir-r4-source/src/root.ts`) for the root. `Source` itself is a phantom grouping: the only real thing is the response kind. Meanwhile the importer preview is a static, grouped-by-resourceType summary that picks one winning source for a whole archive.

**Goal:** collapse recognition + root + confidence into one function on `HttpResponseKind`, delete `Source`, unify the two resource-adoption seams (live constant-root vs archive per-URL-root) into one, and rebuild the importer as a per-URL interactive review with a pluggable file-format framework mirroring the collector slice.

## Locked decisions (from discussion)

1. `HttpResponseKind.isFoundAt: (url)=>boolean` → `tryRecognize: (url)=>Option<RecognizedUrlData>`, `RecognizedUrlData = { specificity: number; source?: { system: string; baseUrl?: string } }`. `None` = "does not claim this URL". **Each kind constructs its own identity** inside `tryRecognize`: FHIR kinds return `source: { system: root, baseUrl: root }` (root from the fused matcher's capture); rexall/shoppers return `source: { system: SID }` (no `baseUrl` — references are relative, matching today's `adoptSourceIdentity({ system: SID })`); web-trace omits `source` entirely (it records, it doesn't import — no dummy `rootUrl` value needed). The structural `source` shape matches `fhir-r4/identity`'s `SourceIdentity`, so the layering seam stays clean without `http-extraction-fundamentals` naming FHIR.
2. Recognize + root fused in `UrlMatch` (one pattern yields both). `specificity` lives **per match**; `Source` and `Source.resolve` are **deleted**. The cross-source ranking convention becomes **exported tier constants in `http-extraction-fundamentals`** (e.g. a `Specificity` namespace: `PORTAL` (100) > `PROTOCOL` (50) > `CATCH_ALL` (0), values preserving today's FHIR=50 mid-rung) that each source package imports — replacing the convention `Source`'s doc comment used to hold.
3. Routing = **highest-specificity wins** (ties → list order), shared by `Extraction.run` and the live tracker. Intra-source pattern disjointness (`mustHaveQuery`) still required.
4. Importer goes **per-URL / flat pool**: each response is recognized independently (accepted behavior change — a stray FHIR URL inside a portal capture now extracts, instead of being quarantined to one winning source).
5. Per-response picker chooses **among the kinds that matched** (usually 1; a real choice only on cross-source overlap).
6. **One combined effort**; **full framework + package split** (importer slice mirrors the collector slice).

## Target architecture

### Package DAG (arrows = "depends on"; layering per `slices/AGENTS.md`)

- **`http-extraction-fundamentals`** (Layer 0, no slice imports) — `HttpResponseKind` (now `tryRecognize`), `UrlMatch` (fused matcher), `HttpResponse`, `Extraction` (new `recognize`/`parseWith`/`routeTo` + rebuilt `run`). **`Source` deleted.**
- **`fhir-r4/identity`** (Layer 1) — `adoptResource` unchanged; **new** per-kind `adoptUnderRecognizedRoot`; `AdoptableEntity.isFoundAt → tryRecognize`. `adoptSourceIdentity` + the `wrappedParses` memo **deleted** (Phase 2).
- **`fhir-r4-source`** (Layer 1) — FHIR kinds carrying `tryRecognize`; `fhirR4SourceEntities` becomes the single pre-adopted definition used by **both** live and archive. **`root.ts`/`fhirRootOf` and `source.ts`/`fhirR4Source` deleted.**
- **`collector-fundamentals` / `*-client-collector` / `collector-react`** (Layer 2) — `CollectorHttpResponseKind` extends the new base; tracker routes via `routeTo`; rexall/shoppers move their constant `sid` onto their kinds (`source.system`); web-trace kind returns `Some({ specificity: CATCH_ALL })` with no `source`. Registry/react untouched.
- **Importer slice, restructured** (Layer 2):
  - **`importer-fundamentals`** (NEW, resource-agnostic upstream) — the `FileImporterDescriptor` contract, the per-response preview + selection-state model (parameterized over `TResource`; the FHIR binding lands in `har-importer-core`), generic persist orchestration.
  - **`har-importer-core`** (NEW) — HAR decode (`web-trace-core/har`), the FHIR response-kind pool (was `importer-core/src/sources.ts`), HAR settings, FHIR persist sink (`withMetaSource`+`persistResources`).
  - **`har-importer-react`** (NEW) — HAR `SettingsPicker` + interactive per-URL `ReviewBody`.
  - **`importer-react`** (shell) — `ImporterScreen`, file picking, persist-on-confirm, and the **closed `format → {descriptor, SettingsPicker, ReviewBody}` registry** (both halves live here; no separate `importer-registry` — the collector one exists only to derive an HTTP-wire union, which the importer has none of).
  - **`importer-core` deleted** (its 4 modules move as above).

### Key types

```ts
// http-response-kind.ts
interface RecognizedUrlData {
  readonly specificity: number
  // The namespace this response's resources key under; absent = recognized
  // but mints no identity (web-trace: it records, it doesn't import).
  // Structurally identical to fhir-r4/identity's SourceIdentity, on purpose.
  readonly source?: { readonly system: string; readonly baseUrl?: string }
}
// specificity.ts — exported tier constants (the ranking Source's doc comment used to hold)
const Specificity = { PORTAL: 100, PROTOCOL: 50, CATCH_ALL: 0 } // higher wins; room between
interface HttpResponseKind<TResources> {
  readonly name: string
  readonly tryRecognize: (url: string) => Option.Option<RecognizedUrlData> // None = no claim
  readonly parse: (r: HttpResponse) => Effect.Effect<readonly TResources[], ParseResult.ParseError>
}

// url-match.ts — make returns the recognizer FUNCTION itself; ^-anchored, scheme REQUIRED, one capture group
type UrlMatcher = (url: string) => Option.Option<string> // Some(captured scheme+authority+basePath prefix) | None
// pattern: ^(https?://[^/]+(?:/[^/?#]+)*?)<segments><end>  → group 1 is the root
// (this is exactly root.ts's PATIENT_ROOT/OBSERVATION_ROOT, now derived from the recognition pattern itself)
// No boolean `test` in the end state: the 8 isFoundAt call sites are its only production consumers and all
// die in Phase 1; consumers interpret the Option. (Phase 0 shipped a transitional {test, recognizeRoot}
// object — Phase 1 collapses it to the bare function and drops the test===isSome invariant property, which
// dissolves by construction. The two collector-fundamentals test files using matchers as Step patterns
// switch to plain RegExp literals; Step.UrlPattern stays the structural { test } the FSM consumes, its doc
// dropping the UrlMatch mention.)

// extraction.ts — split primitives; run() rebuilt on them, four-way output unchanged
// routeTo is generic in the CONCRETE element (constraint = just the tryRecognize field, à la Source.resolve's
// Pick constraint) so the live tracker keeps CollectorHttpResponseKind.followUpSteps through it.
const routeTo: <K extends Pick<HttpResponseKind<unknown>, 'tryRecognize'>>(
  pool: readonly K[],
  url
) => Option<{ kind: K; recognized: RecognizedUrlData }> // max spec, ties→order
const recognize: <T>(
  pool,
  responses
) => readonly { ref; candidates: readonly { kindName; recognized: RecognizedUrlData }[] }[] // sorted desc; []=no match
type ParseOutcome<T> =
  { _tag: 'resources'; resources } | { _tag: 'parseError'; error } | { _tag: 'bodyAbsent' }
const parseWith: <T>(kind, response) => Effect.Effect<ParseOutcome<T>>

// fhir-r4/identity — structural, no http-extraction-fundamentals import
interface AdoptableEntity {
  readonly name: string
  tryRecognize(url: string): Option.Option<{
    readonly specificity: number
    readonly source?: SourceIdentity // the existing { system; baseUrl? }
  }>
  // Narrowed from today's `unknown` to the one field the combinator reads.
  // Method syntax → bivariant param, so kinds typed against HttpResponse /
  // CollectorHttpResponse stay assignable (same trick the interface uses today).
  parse(response: {
    readonly url: string
  }): Effect.Effect<readonly FhirResource[], ParseResult.ParseError>
}
// No options: the identity comes verbatim from tryRecognize(response.url).source.
// A parse on a response tryRecognize returns None for (or Some with no `source`)
// FAILS with a ParseResult.ParseError naming the real reason ("URL not recognized
// by this kind — cannot adopt an identity") — the digestFailureAsParseError
// precedent (web-trace raw-exchange kind): no channel widening, no defect, and
// Extraction.run reports it as an ordinary per-response parseFailure.
const adoptUnderRecognizedRoot: <T extends AdoptableEntity>(
  entity: T & EntityParsesEveryResource<T>
) => T

// importer-fundamentals
interface FileImporterDescriptor<TSettings, TResource, R> {
  readonly format: string
  readonly display: { title; description }
  readonly defaultSettings: TSettings
  readonly pool: readonly HttpResponseKind<TResource>[]
  decode(fileText, settings): Effect.Effect<readonly Extraction.Input[], ParseResult.ParseError>
  persist(resources, sourceRef): Effect.Effect<readonly PersistFailure[], never, R>
}
interface ReviewSelection {
  enabledKinds: ReadonlySet<string>
  overrides: ReadonlyMap<string, string>
} // responseId→kindName
```

## The adoption-seam redesign (the conceptual payoff)

Both current wrappers do the same job with the identity sourced differently — `adoptSourceIdentity(constant)(plan)` (live) and `adoptedUnderResponseRoot` (archive, per-URL). Collapse into **one** option-less per-kind combinator whose identity comes verbatim from `entity.tryRecognize(response.url).source` — each kind constructs its own identity:

- **FHIR** (`fhir-r4-source`): `fhirR4SourceEntities = fhirR4ResponseKinds.map(adoptUnderRecognizedRoot)`. Each kind's `tryRecognize` returns `source: { system: root, baseUrl: root }` with root = URL-derived from the fused matcher's capture (was `fhirRootOf`). `config.rootUrl` keeps only its **navigation** role (the plan's `Open` steps still target `${config.rootUrl}/Patient/…`).
- **Rexall / Shoppers**: `tryRecognize` stays **URL-gated** — `url => matcher.recognizeRoot(url) ? Some({ specificity: Specificity.PORTAL, source: { system: SID } }) : None`. The SID (`REXALL_CAREBOOK_SYSTEM`/`SHOPPERS_DRUGMART_SYSTEM`, hardcoded literals) rides only the `source.system` value with **no `baseUrl`** (references are relative — exactly today's `adoptSourceIdentity({ system: SID })`); the **match decision still comes from the kind's own pattern**, so intra-collector routing stays disjoint. ⚠ **Do NOT make these kinds claim every URL** — under highest-specificity routing that would send every response to the first-listed kind (whose `parse` then fails), silently killing a production collector past the by-name test safety nets.
- **web-trace recorder**: `tryRecognize` must be **total** — always `Some`, never throw. It is the catch-all whose _miss_ would fire `CancelSnifferRequest` and abort the user's live browsing, and `new URL(url)` throws on malformed/relative URLs. Return `Some({ specificity: Specificity.CATCH_ALL })` — **no `source` field at all** (it records, it doesn't import; no dummy value to invent, no URL parsing that could throw). The plan is **not** adopted (its ids are `(sessionId,requestId)`; adopting would hash a hash). Add a test: a URL `new URL` rejects still yields `Some`.

Consequences: the `wrappedParses` memo (and its "unbounded, user-driven key" caveat) is **deleted** — the combinator takes no source parameter, so each package applies it once at module load and two plans from one config share the same frozen array by identity (deep-equal gets _easier_). A wrapped `parse` on a response the kind's `tryRecognize` returns `None` for (or `Some` with no `source`) **fails with a `ParseResult.ParseError`** naming the real reason — the `digestFailureAsParseError` precedent — rather than passing through un-adopted (today's silent behavior) or dying; `Extraction.run` reports it as an ordinary per-response `parseFailure`. `AdoptableEntity.parse`'s structural parameter narrows from `unknown` to `{ readonly url: string }` (the one field the combinator reads; bivariant method param keeps concrete kinds assignable). `EntitiesParseEveryResource` relocates from plan-level to per-kind — and so it must be applied to kinds already widened to `HttpResponseKind<FhirResource>` (the guard reads `ParsedBy` off the element; individual kinds are declared narrow, e.g. `HttpResponseKind<PatientType>`). FHIR maps the already-wide `fhirR4ResponseKinds`; **rexall's `as readonly HttpResponseKind<FhirResource>[]` widening moves from the plan factory to module scope before the `.map`** (shoppers kinds are already wide). `AdoptableEntity.isFoundAt→tryRecognize` is a type-level rename (the field is only spread through).

## Phase plan (each phase ends `vp run pack` + `vp test` green)

- **Phase 0 — UrlMatch fusion (isolated, green).** `make` returns `UrlMatcher{test, recognizeRoot}`; keep `test` so the 8 `matcher.test(url)` call sites stay green. `url-match.test.ts` gains `recognizeRoot` cases; non-`http(s)` schemes now `test` false (deliberate tightening — cleanly removes the "matched isFoundAt but no root" edge case `source-entities.ts` handles today).
- **Phase 1 — Recognition flip (one bounded red window inside a single commit; `Source` deleted).** `UrlMatch.make` collapses to the bare recognizer function (drop `test` + the invariant property; flip the two collector-fundamentals test files' step-pattern fixtures to `RegExp` literals; trim `UrlPattern`'s doc). `HttpResponseKind`→`tryRecognize` + `RecognizedUrlData`; `Extraction` gains `recognize`/`parseWith`/`routeTo`, rebuilds `run`; delete `source.ts`/`source.test.ts` + `index.ts` export; migrate `test-helpers.ts`. All 8 collector/source response kinds → `tryRecognize` (URL-gated; rexall/shoppers put the constant `sid` in `source.system`, no `baseUrl`); web-trace → total `Some` with no `source` (never throw). `fhir-r4-source`: delete `root.ts`, rewrite `source-entities.ts` to `adoptUnderRecognizedRoot`, delete `source.ts`. `collector-fundamentals`: new base + `routeTo` + test helpers. `fhir-r4/identity`: `AdoptableEntity.tryRecognize` + **add** `adoptUnderRecognizedRoot` (keep `adoptSourceIdentity` this phase so collectors compile / live keying unchanged). `importer-core` (still one package): flat pool + `Extraction.run`, per-URL preview (drop `sourceTag`/`NoSourceClaims`); update `preview-panel.tsx` to the per-URL (still non-interactive) model. **Same-commit ripple (required for green):** the full `importer-react` fan-out of dropping `sourceTag`/`NoSourceClaims` — `use-confirm-import.ts` (`NoSourceClaims` match), `import-outcome.ts`, `use-import-run.ts`, and the four preview/screen `.test.tsx/.test.ts`; delete/rewrite `fhir-r4-source/src/source.test.ts` (`.rootOf`/`.claims` → `tryRecognize`); and rewrite `fhir-r4-client-collector/src/source-parity.test.ts` (it imports the now-deleted `fhirR4Source`/`fhirRootOf`). Every deleted symbol's consumers land in this commit or the phase is red.
- **Phase 2 — Adoption unification (green; the one live-behavior change).** Switch fhir/rexall/shoppers configs from `adoptSourceIdentity(...)(plan)` to pre-adopted module kinds (widen-first per above). Delete `adoptSourceIdentity`+memo (rename the module). Simplify `source-parity.test.ts` **but keep** the load-bearing `tryRecognize(${config.rootUrl}/Patient/…).source.system === config.rootUrl` property (was `fhirRootOf===config.rootUrl`) — post-unification the live==archive assertions become tautologies, so that property is the only real guard on the keying switch. Review the 3 `config.test.ts` deep-equal suites (pre-adopt-at-module-load keeps them green, more easily).
- **Phase 3 — Framework split + interactive UI (green).** Create `importer-fundamentals`, `har-importer-core`, `har-importer-react`; move importer-core modules; rewrite `importer-react` as the shell + closed `format→{...}` registry; build the interactive `ReviewBody` on `recognize`/`parseWith` (per-URL list, per-response picker among matched kinds defaulting to top specificity, whole-import kind toggle, collapsible no-match, persist-only-chosen). Delete `importer-core`.
- **Phase 4 — Docs/AGENTS sweep (green, docs only).**

## Behavior changes / risks to accept

- **Importer is per-URL now** (locked decision 4): a mixed archive extracts every recognized URL, not one quarantined source.
- **Live FHIR keying moves from config-constant to per-response-derived root.** Same-server captures are byte-identical (pinned by `source-parity.test.ts`: `fhirRootOf(configuredUrl)===config.rootUrl`). **Edge case:** a FHIR endpoint that redirects cross-origin/cross-basepath — the sniffer pins `response.url` at `ResponseStart`, so the derived root becomes the redirect target where config-constant keying used `config.rootUrl`. Call this out in `Source Identity Explanation.md`.
- **`UrlMatch` now requires `http(s)`** — a deliberate tightening; a root must be a valid `new URL` system anyway.
- **Intra-collector pattern disjointness is still required.** Highest-specificity routing only disambiguates the importer's cross-source pool; within one collector plan the kinds must stay disjoint, or the tie→list-order rule reintroduces the old ordering dependency. Document alongside the existing "keep patterns disjoint" guardrail.

## Test + doc surface

- **Tests** (move/rewrite, by phase): fundamentals `url-match`/`http-response-kind`/`extraction`/`test-helpers` (delete `source.test.ts`); `fhir-r4-source` response-kind + `source-entities` tests (absorb `source.test.ts` rootOf cases into `tryRecognize`); `collector-fundamentals` handler/tracker/parity/lifecycle helpers; rexall/shoppers/web-trace response-kind tests + `web-trace config.test.ts:146`; `fhir-r4/identity` `adopt-source-identity.test.ts`→per-response identity (with-`baseUrl` and without-`baseUrl` kinds, plus the unrecognized-URL `ParseError` arm); `source-parity.test.ts` + 3 collector `config.test.ts`; importer tests relocate into the new packages + interactive-review tests.
- **Docs (AGENTS.md + explanations):** `slices/AGENTS.md`, `http-extraction/AGENTS.md` + `http-extraction-fundamentals/AGENTS.md` (drop `Source`; document `recognize`/`parseWith`/`routeTo`/fused `UrlMatch`); `fhir-r4-source/AGENTS.md` (remove `root.ts`/`fhirRootOf`/`fhirR4Source`); `collector/AGENTS.md` ("first isFoundAt match" → highest-specificity; `adoptSourceIdentity`→`adoptUnderRecognizedRoot`); `emr/AGENTS.md`; per-collector AGENTS (fhir live-keying + redirect caveat, rexall/shoppers constant-sid-on-kind, web-trace catch-all wording); **`Source Identity Explanation.md`** (heaviest edit — unify the two adoption wrappers, memo removal, live-keying switch); importer docs (rewrite `importer/AGENTS.md` + `importer-react/AGENTS.md`, replace `importer-core/AGENTS.md`, add AGENTS.md for the 3 new packages, add an "Adding a File-Format Importer How-To").

## Verification

- After each phase: `vp run pack` then `vp test <touched packages>` (build first — cross-package imports resolve against `dist/`), and `vp check <touched src dirs>` for fmt/lint/typecheck.
- Adoption/id safety net: `fhir-r4-client-collector/src/source-parity.test.ts` must stay green (live == archive == byte-identical ids for a same-server capture) — the guard for the keying switch.
- Live/archive routing parity: `collector-fundamentals/src/handler/extraction-parity.test.ts` must stay green (the tracker and `Extraction.run` route identically under `routeTo`).
- Interactive UI: `har-importer-react` review tests (default pick = top specificity; toggling a kind off re-recognizes; no-match fold; persist writes only chosen parses) + manual `vp run dev` smoke of `ImporterScreen`.
- Full pre-PR gate: `vp run ready` (+ `./scripts/checks/rust.sh` is a no-op here — no Rust touched).

## Critical files

- `slices/http-extraction/http-extraction-fundamentals/src/{http-response-kind,url-match,extraction,source}.ts`
- `slices/http-extraction/fhir-r4-source/src/{source-entities,root,source,plan-entities}.ts` + `response-kinds/*`
- `slices/emr/fhir-r4/src/identity/adopt-source-identity.ts` (+ `adopt-resource.ts` for `SourceIdentity`)
- `slices/collector/collector-fundamentals/src/handler/collector-bridge-message-handler.ts` + `model/collector-http-response-kind.ts`
- `slices/collector/{fhir-r4-client,rexall-be-well,shoppers-drugmart,web-trace}-collector/src/config.ts` + `response-kinds/*`
- `slices/importer/importer-core/src/{sources,har-import,import-preview,persist-preview}.ts` (split targets for the new packages)
- `slices/importer/importer-react/src/**` (shell + registry + interactive review)
