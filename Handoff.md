# Handoff

## What we're doing and why

The identity map epic (#1414) links an import's people and providers to the
server's records. Two stacked PRs are in flight, both authored by `ruths-machine`
and reviewed by Ruth (`ruthmarks151`) plus an opus `/code-review high` pass:

- **#1425** `referent-search-lift-1418` → `epic/identity-map`: `ReferentSearch`
  (a referent's default link choice by identifier search), `TokenSearchParam`
  in fhir-r4, one link plan per batch (`Referent.discover` / `IdentityMap.apply`
  over the batch's files, `Placement.appendLinkedSection`), importer-core's
  `discoverReferents` / `applyIdentityMap`. **Ready, green CI, assigned to
  Ruth, not merged**: Ruth wants the items below done or designed first.
- **#1426** `identity-map-screen-1419` → `referent-search-lift-1418` (draft,
  stacked): the identity map in the React screen (`useIdentityMap`,
  `ReferentRows`, `useStoredResources`), `searchAllPages` and
  `Patient.demographics` in fhir-r4. Drafts skip the TypeScript CI jobs (see
  `docs/CI/Required Check Explanation.md`), so its green `Required` is all
  skips until it is flipped.

Ruth has answered every review item; the decisions are recorded under "What
remains". The user wants opus subagents for subtasks and a careful hand on the
model (see Gotchas). Every PR thread already has a reply; threads for fixed
items are resolved, threads for pending items are open.

## What's done

- #1425 re-expressed on the merged #1424 model (Effects on the clock,
  `HashMap`s, `AsResource`/`ByMentionOnly`, `LinkToStoredResource` etc.).
  Commits on the branch: fhir-r4 `TokenSearchParam`; one plan per batch;
  `ReferentSearch`; importer-core lift; `apply`/`discover` take the batch (no
  single-file aliases); the search tie-break (own identifiers first, derived
  only on no hit, `_count=2`, two hits = ambiguous = kind's default). Issue
  **#1431** filed for one search per resource type (starts with tests).
- #1426 rewritten on #1425's head, all 13 of Ruth's comments and the review's
  findings addressed: Effect `HashMap`s, `Patient.demographics` as the one
  normalisation (given names compared too), groups generic over
  `LinkableLogicalReference.RESOURCE_TYPES`, `Array.countBy`, `SelectOption`
  component, memoised options and rows plus a limited performance test,
  `searchAllPages`/`nextPageToken` moved to `fhir-r4/clients`, "server" not
  "device", stored-list failure surfaced, unfollowable choices dropped from the
  reviewer's choices before the defaults, dedupe by literal reference,
  `staleTime: Infinity` + `gcTime: 0` on the stored list, refusal after a
  re-decode shown above the previous review with confirm disabled, tally
  counting records not referents.
- Learnings Inbox: `Stream.paginateEffect` state typing; workspace-wide
  `vp run test:changed` can kill the cloud worker.

## What remains

Decisions are Ruth's words from the last exchange; "go" means build it.

### #1425 (then merge: Ruth said merge when the opus review and I are satisfied)

1. **Re-import default (go).** Today a re-import links the decoded Patient to
   its own stored copy, so the stored copy is written byte for byte and the new
   decode's demographics and `meta.source` are lost. Plan agreed: (a) in
   `PlacedResource.make`, when a placed literal reference has both a `Decoded`
   and a `Stored` link, the **decoded** resource is written and it assumes the
   stored copy's identifiers (today "the last link's copy wins"); (b)
   `ReferentSearch.defaultChoice` returns `CreateResource` when the one hit has
   the decoded resource's own id. Test the re-import round trip in
   `identity-map.test.ts` (the account mention's search still finds the stored
   copy, so the account lands `Stored` and the Patient `Decoded` under one
   literal reference; the decoded copy must win and carry the account id).
   Then reply on thread 4383546318 and resolve it.
2. **Batch-level Linked slot (design agreed, own PR after #1425 merges).**
   `IdentityMap.apply` returns `{ placedFiles, linked, links }`;
   `BatchDecodeResult` gains `linked: readonly DecodedFile.Resource[]` (not a
   format); the preview shows a read-only "Linked records" group **below** the
   format groups; **linked records are not excludable or editable** (change the
   link choice instead); the server diff covers them; the confirm writes the
   Linked bundle first and skips the formats if it fails; `appendLinkedSection`,
   `LINKED_SECTION_TITLE`, `linkedKey` and the first-file rule go away. Also
   removes 1426's second `LinkPlan.make` (its hook reads `links`). Open
   threads to answer when this lands: 4383546160, 4383546442, 4383546613 on
   #1425 and 4383784670 on #1426.
3. **Cross-format writes (research first).** Ruth prefers a FHIR `transaction`
   bundle if the Wildflower server (HFS, `apps/host/wildflower-server`,
   `fhir-r4-rust`) supports it; otherwise one `batch` bundle per confirm with
   per-entry outcomes attributed back to formats. Research: grep the Rust
   server for `transaction` handling of `POST /` bundles and the OpenAPI
   snapshot; `persistBatchBundle` in `fhir-r4/clients` is the current sink.
   Report findings before building.

### #1426

1. **`Patient.demographics` on the current name (Ruth leans to this; wants the
   cost first).** Cost: `Patient.nameBirthDateIdentifier` and `demographics`
   become Effects reading `DateTime.now` (they need `HumanName.displayName(name,
   now)`), so fhir-r4 gains a clock-dependent identifier; its #1423 tests pinned
   on `name[0]` need a `TestClock`; `LinkableResource.maybeDerivedIdentifier`
   is already an Effect so the map is unaffected; a stored person renamed after
   import carries the old derived identifier (the person keeps both, the
   own-id search still finds them). About half a day. Alternative (cheaper):
   keep the identifier on `name[0]`, have `demographics` return every name's
   parts and warn only when no stored name matches. Thread 4383784267.
2. **Server diff after a failed first diff (Ruth likes the panel staying up;
   wants the cost).** Cost: `useServerDiff` keeps its last settled result per
   batch in state and reports `ready, refreshing: true` with it while the next
   query is pending, so the panel shows stale "every id is new" verdicts during
   the refresh (confirm is already disabled while refreshing); plus `retry: 2`
   on the diff query re-sends the whole batch's GET bundle up to twice on
   failure. No duplicate queries otherwise: each placing is a new key. Thread
   4383784085.
3. **Plan computed twice.** No decision needed: resolves with the Linked slot
   (its `links`). Thread 4383784670.
4. When #1425 merges: retarget #1426 to `epic/identity-map`, flip to ready,
   assign `ruthmarks151`, re-run `/code-review high --comment` if asked.

## Key files to read first

- `slices/importer/importer-fundamentals/AGENTS.md` (identity-map section and
  the "Identity is the map's" guardrail): the model and its names.
- `slices/importer/importer-fundamentals/src/identity-map/placed-resource.ts`
  and `referent-search.ts`: where #1425 item 1 lands.
- `slices/importer/importer-react/src/identity/use-identity-map.ts` and
  `src/preview/use-server-diff.ts`: where #1426 items 1–2 land.
- `slices/importer/importer-core/src/identity-map.ts`: the lift the Linked slot
  reshapes.
- `docs/Style/Style Guide Reference.md` and `docs/Agents/Review Standards
  Reference.md`: read before any PR (CLAUDE.md requires it).

## Gotchas and context the next agent needs

- Work on the PR branches directly (`referent-search-lift-1418`,
  `identity-map-screen-1419`), not `claude/gallant-feynman-u1npzd`; the user
  agreed. After pushing to #1425, **rebase #1426 onto it** (`git rebase
  referent-search-lift-1418` from the 1426 branch) and force-push with
  `--force-with-lease`. Pushes work from this cloud container; the first push
  of a session is held once by a hook asking whether tests ran.
- Run checks per package from its directory (`vp check`, and the repo root's
  `node_modules/.bin/vp test` for jsdom packages). `vp run test:changed` over
  the whole workspace killed this session's worker (memory). Build upstream
  packages first (`vp run -F <pkg> build`) or typecheck resolves against stale
  `dist/`.
- The pre-commit hook runs `vp run pack` + `vp check --fix` on staged files;
  `--fix` reformats, so exact-string patches written before a commit can miss
  afterwards. A WIP commit with type errors needs `--no-verify`.
- `vp check` prints only formatting errors until formatting passes; run
  `vp check --fix` first, then `vp check`.
- The stub servers in `referent-rows.test.tsx` and `importer-screen.test.tsx`
  must answer a search with resources of the **searched type**; a Patient in a
  Practitioner search fails the typed decode and the whole default search.
- `Stream.paginateEffect`'s state must be the raw cursor (`string | null`),
  not an `Option` (see Learnings Inbox).
- Code-review subagents: `general-purpose`, model `opus`, told to invoke the
  `code-review` skill with `high --comment <pr>`; they post via `gh api` and
  report findings without severity markers, so triage them yourself.
- Ruth's review style: names first ("what is this, really?"), types must earn
  their keep, errors bubble, no backwards compatibility, Effect data modules
  over hand loops, answer every comment and apply each principle across the
  whole PR.

## Current state

- `identity-map-screen-1419` at `08a184a`, pushed, clean.
- `referent-search-lift-1418` at `432d791`, pushed, CI green, PR #1425 ready
  and assigned to Ruth.
- This file is committed on `claude/gallant-feynman-u1npzd` only, so neither
  PR carries it.
