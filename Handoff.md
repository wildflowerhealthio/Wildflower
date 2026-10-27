# Handoff

## What we're doing and why

The identity map epic (#1414) links an import's people and providers to the
server's records. Two stacked PRs are in flight, both authored by `ruths-machine`
and reviewed by Ruth (`ruthmarks151`) plus an opus `/code-review high` pass:

- **#1425** `referent-search-lift-1418` → `epic/identity-map`: `ReferentSearch`
  (a referent's default link choice by identifier search), `TokenSearchParam`
  in fhir-r4, one link plan per batch (`Referent.discover` / `IdentityMap.apply`
  over the batch's files, `Placement.appendLinkedSection`), importer-core's
  `discoverReferents` / `applyIdentityMap`. **Ready, assigned to Ruth, not
  merged**: Ruth said merge once the agreed items are in and the review is
  satisfied; see "What remains" for the one open question before merging.
- **#1426** `identity-map-screen-1419` → `referent-search-lift-1418` (draft,
  stacked): the identity map in the React screen (`useIdentityMap`,
  `ReferentRows`, `useStoredResources`), `searchAllPages` and
  `Patient.demographics` in fhir-r4. Drafts skip the TypeScript CI jobs (see
  `docs/CI/Required Check Explanation.md`), so its green `Required` is all
  skips until it is flipped.

Ruth has answered every review item; the decisions are recorded under "What
remains" and are final unless marked open. The user wants opus subagents for
subtasks and a careful hand on the model (see Gotchas). Every PR thread already
has a reply; threads for fixed items are resolved, threads for pending items are
open.

## What's done

- #1425 re-expressed on the merged #1424 model (Effects on the clock,
  `HashMap`s, `AsResource`/`ByMentionOnly`, `LinkToStoredResource` etc.).
  Commits on the branch: fhir-r4 `TokenSearchParam`; one plan per batch;
  `ReferentSearch`; importer-core lift; `apply`/`discover` take the batch (no
  single-file aliases); the search tie-break (own identifiers first, derived
  only on no hit, `_count=2`, two hits = ambiguous = kind's default); and the
  **re-import default** (commit `672f847`): a one-hit search on the decoded
  resource's own id defaults to `CreateResource`, and in `PlacedResource.make`
  a placed literal reference with both a `Decoded` and a `Stored` link writes
  the decoded resource, which assumes the stored copy's identifiers
  (`Link.LinkedResource` now carries its target). Issue **#1431** filed for one
  search per resource type (starts with tests).
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
- Learnings Inbox (on the 1426 branch): `Stream.paginateEffect` state typing;
  workspace-wide `vp run test:changed` can kill the cloud worker.

## What remains

Decisions are Ruth's; "go" means build it.

### #1425

1. **Open question before merging (Ruth to decide).** After `672f847`, a
   re-imported decode inherits the stored copy's identifiers only when some
   mention in the batch links to that copy (that is what makes the copy a
   `Stored` link under the same literal reference). An identifier the copy
   assumed in an earlier import, which this import does not mention, is
   dropped by the `PUT`. The clean fix: the own-id search hit (the stored copy)
   is carried into the plan as "the stored copy to assume from" even with no
   mention linking there, for example a `LinkTarget.Decoded` that carries an
   `Option` of the stored copy, or the lift taking stored copies by literal
   reference. Thread 4384557395 on #1425 states the gap. Ask Ruth, or propose
   the fix on the thread and wait.
2. **Merge #1425** once item 1 is settled and CI is green on the head. Then
   retarget #1426 to `epic/identity-map`, flip it to ready, assign
   `ruthmarks151`, and run `/code-review high --comment 1426` (an opus
   `general-purpose` subagent invoking the `code-review` skill).
3. **Batch-level Linked slot (design agreed, own PR after #1425 merges).**
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
4. **Cross-format writes.** Ruth prefers a FHIR `transaction` bundle if the
   Wildflower server (HFS, `apps/host/wildflower-server`, `fhir-r4-rust`)
   supports it; otherwise one `batch` bundle per confirm with per-entry
   outcomes attributed back to formats. A subagent was asked to research
   whether `POST /` handles `transaction`; its report may be in this session's
   transcript, else grep the Rust server and the OpenAPI snapshot under
   `slices/fhir/fhir-r4/openapi`. Report findings before building; this is
   part of the Linked slot PR's confirm change.

### #1426

1. **`Patient.demographics` on the current name (go; Ruth: "worth it to make
   the function more accurate").** `Patient.nameBirthDateIdentifier` and
   `demographics` become Effects reading `DateTime.now`, picking the current
   name with `HumanName.displayName(name, now)` (the pick `LinkableResource.
   maybeDisplayName` already uses) instead of `Array.head(patient.name)`. The
   #1423 tests pinned on `name[0]` move onto a `TestClock`
   (`Effect.provide(TestContext.TestContext)`); `LinkableResource.
   maybeDerivedIdentifier` is already an Effect so the map is unaffected;
   `referent-rows.tsx`'s `differingPatientDemographics` becomes an Effect run
   where the lines are built (the rows memo already runs placing synchronously;
   label the compared demographics on the way in like the stored list, or run
   `Effect.runSync` in the memo as the hook does). Callers to check: anything
   in synthetic-data or tests calling `nameBirthDateIdentifier` directly. A
   renamed stored person keeps the old derived identifier (the own-id search
   still finds them). Reply on thread 4383784267 and resolve it.
2. **Server diff: keep the panel up after a failed first diff (go).** In
   `use-server-diff.ts`, keep the last settled result per batch in state and,
   while the next query is pending for the same batch, report `ready` with
   those comparisons and `refreshing: true` (the error state's comparisons are
   "every id is new"), so the panel never unmounts on a link change; add
   `retry: 2` so a failed diff is retried (Ruth: no duplicate queries, retry
   failed ones). Keep the existing rule that a fresh pick (new batch id)
   carries nothing over. Update the hook's doc comment and the AGENTS note on
   `useServerDiff`. Reply on thread 4383784085 and resolve it.
3. **Plan computed twice.** No decision needed: resolves with the Linked slot
   (its `links`). Thread 4383784670.

## Key files to read first

- `slices/importer/importer-fundamentals/AGENTS.md` (identity-map section and
  the "Identity is the map's" guardrail): the model and its names.
- `slices/importer/importer-fundamentals/src/identity-map/placed-resource.ts`
  and `referent-search.ts`: the re-import rule and where its open gap lives.
- `slices/fhir/fhir-r4/src/resources/patient/patient.ts` and its test: where
  #1426 item 1 lands.
- `slices/importer/importer-react/src/identity/use-identity-map.ts`,
  `src/identity/referent-rows.tsx` and `src/preview/use-server-diff.ts`: where
  #1426 items 1–2 land.
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
  afterwards. A WIP commit with type errors needs `--no-verify`. The auto-mode
  permission classifier refuses some combined git commands (`stash` +
  `checkout -B`, `checkout -B` with `--no-verify`); run them one at a time.
- `vp check` prints only formatting errors until formatting passes; run
  `vp check --fix` first, then `vp check`.
- The stub servers in `referent-rows.test.tsx` and `importer-screen.test.tsx`
  must answer a search with resources of the **searched type**; a Patient in a
  Practitioner search fails the typed decode and the whole default search.
  The screen test's "reads only …" assertion lists every GET; a Patient with
  a name and birth date now makes two searches (own, then derived) when
  nothing is found, a bare one makes one.
- `Stream.paginateEffect`'s state must be the raw cursor (`string | null`),
  not an `Option` (see Learnings Inbox).
- Code-review subagents: `general-purpose`, model `opus`, told to invoke the
  `code-review` skill with `high --comment <pr>`; they post via `gh api` and
  report findings without severity markers, so triage them yourself.
- Ruth's review style: names first ("what is this, really?"), types must earn
  their keep, errors bubble, no backwards compatibility, Effect data modules
  over hand loops, answer every comment and apply each principle across the
  whole PR. Every GitHub post ends with a blank line, `---`, and
  `_Generated by [Claude Code](https://claude.ai/code)_`.

## Current state

- `referent-search-lift-1418` at `672f847`, pushed; check CI on that head
  before merging (the previous head `432d791` was fully green).
- `identity-map-screen-1419` was being rebased onto `672f847` by a subagent
  when this was written (9 commits, top `63020ed`); confirm it was
  force-pushed (`git log origin/identity-map-screen-1419 -1`), and if not,
  run its checks and push it with `--force-with-lease`.
- This file is committed on `claude/gallant-feynman-u1npzd` only, so neither
  PR carries it.
