# Handoff

## What we're doing and why

The identity map epic (#1414) links an import's people and providers to the
server's records. Three PRs, all authored by `ruths-machine`, reviewed by Ruth
(`ruthmarks151`) plus opus `/code-review high --comment` passes:

- **#1425** `referent-search-lift-1418` → `epic/identity-map`: **merged**
  (squash `dc9765a`). Ruth read it after the merge and accepted it.
- **#1426** `identity-map-screen-1419` → `epic/identity-map`: the identity map
  in the React screen. **Ready, assigned to Ruth, CI green on head `b512ebd`.**
  **Ruth merges it herself; do not merge it, whatever happens.** The opus
  review's findings were addressed in `b512ebd`.
- **#1435** `linked-slot-1433` → `identity-map-screen-1419` (draft, stacked;
  closes #1433): the batch-level Linked slot and the one-transaction confirm.
  Two commits: `873c8df` (fhir-r4 `persistTransactionBundle`, fhir-r4-rust
  atomicity tests) and `6e001ca` (fundamentals, core, shell). Drafts skip
  every CI job, so its green `Required` is all skips; every package's checks
  and suites passed locally (see Verification in the PR body).
- **#1434** `ruths-machine/pages-publish-no-auto-gc` → `main`: a one-line fix
  for the preview-deploy flake (`git gc --auto` racing the `rm -rf` of the
  site clone). Ready, assigned to Ruth, CI green.

Ruth's decisions on every earlier review item are built. The session is
subscribed to #1426, #1434 and #1435 for events.

## What's done this session

- #1425: the re-import identifier gap closed with `LinkChoice.
  UpdateStoredResource({ resource })` (writes the decode over its stored copy,
  assuming every identifier the copy carries; `LinkTarget.Decoded` carries
  `storedCopy: Option`; `PlacedResource.make` is the one place identifiers are
  carried forward); second opus round's ten findings fixed (`choiceAmong`,
  `LinkPlan.writtenAsDecoded`, `Referent.ownLogicalReferencesOf` excludes
  derived identifiers, `matchesIn` / `MatchWithoutResource`); merged.
- #1426: rebased onto the merged 1425, rows adapted to `UpdateStoredResource`
  (`update:Patient/<id>` option, `UPDATE_LABEL`); `Patient.demographics` and
  `nameBirthDateIdentifier` are Effects on the clock picking the current name
  (`HumanName.currentName`); `useServerDiff` keeps the last settled verdicts
  up with `refreshing: true` and `retry: 2`; `searchAllPages` with a page limit
  and `SearchPages { matches, truncated }`, the rows say when the stored list
  was cut off; `useIdentityMap` prefetches the stored lists; per-referent line
  cache (`buildLines`) so `memo` skips; flipped to ready, assigned Ruth, opus
  review run and its findings fixed.
- #1435: everything listed in its PR body. Replies posted on the #1425 threads
  (4383546160, 4383546442, 4383546613, 4384710763, 4384711421) and the #1426
  threads (4383784670, 4384886567) pointing at it.
- Open design threads on #1425 left for Ruth, answered but unresolved: field
  merge on re-import (4384711015), merging two decoded people (#1432 filed,
  4384711106), `Identifier.system` href normalisation (4384712346).

## What remains

1. **Watch #1426** until Ruth merges it. Address any review she leaves. Never
   merge.
2. **When #1426 merges:** retarget #1435 to `epic/identity-map`, flip it to
   ready, assign `ruthmarks151`, and run `/code-review high --comment 1435`
   (an opus `general-purpose` subagent invoking the `code-review` skill), then
   triage its findings. Flipping it is what makes CI actually run (TypeScript
   jobs, Rust nextest for `fhir-r4-rust`, API sync).
3. **#1434**: waiting on Ruth; nothing to do unless CI or review changes.
4. **Learnings Inbox** entries not yet written (append under the marker in
   `docs/Agents/Learnings Inbox.md` on whichever PR branch is next pushed):
   - A hook test that creates a new `QueryClient` inside the wrapper on each
     render never settles its queries; create one per rendered hook.
   - HFS 0.2.5 accepts a `PUT Patient/x` whose body has another `id` inside a
     transaction (it rewrites the id); refuse a transaction in a test with a
     `resourceType` mismatch instead.
   - The preview deploy's `git gc --auto` detaches and races the EXIT trap's
     `rm -rf`; `git config gc.auto 0` right after `git init` (#1434).
   - `vp run test:changed` workspace-wide can kill the cloud worker (memory);
     run suites per package.
5. **Possible follow-up tests (not required):** an end-to-end screen test of a
   mention-only referent linked to a stored record, which exercises the Linked
   records group and the transaction through the real decode. The current
   HAR fixtures (`screen-fixtures.ts`) all carry a Patient resource, so one
   with an Observation whose `subject` names a Patient by identifier only
   would have to be built.

## Key files to read first

- `slices/importer/importer-fundamentals/AGENTS.md` (identity-map section):
  the model, `PlacedBatch`, the "Identity is the map's" guardrail.
- `slices/importer/importer-core/src/identity-map.ts` and `read-batch.ts`:
  the `linked` slot and `PlacedBatchResult`.
- `slices/importer/importer-react/src/run/use-confirm-import.ts`: the one
  transaction and `outcomesPerUnit`.
- `slices/importer/importer-react/src/preview/use-server-diff.ts` and
  `preview-panel.tsx`: `ReviewGroup`, `LINKED_GROUP`, the read-only group.
- `slices/fhir/fhir-r4/src/clients/persist-batch-bundle.ts`: `persistBundle`.
- `apps/host/wildflower-server/fhir-r4-rust/tests/batch_bundle_at_base.rs`:
  the atomicity tests.
- `docs/Style/Style Guide Reference.md` and `docs/Agents/Review Standards
  Reference.md`: read before any PR (CLAUDE.md requires it).

## Gotchas and context the next agent needs

- Work on the PR branches directly (`identity-map-screen-1419`,
  `linked-slot-1433`), not `claude/gallant-feynman-u1npzd`; the user agreed.
  After a push to 1426, rebase 1435 onto it and force-push with
  `--force-with-lease`.
- **Do not merge anything.** The user merged nothing but 1425 (and that only
  because the merge happened before the "don't merge" message arrived).
- Run checks per package from its directory (`vp check --fix`, then
  `vp check`; the repo root's `node_modules/.bin/vp test` for jsdom
  packages). Build upstream packages first (`vp run -F <pkg> build`) or
  typecheck resolves against stale `dist/`. The pre-commit hook runs
  `vp run pack` and `vp check --fix` on staged files, so an exact-string
  patcher's anchors can move after a commit.
- Rust: there is no `cargo nextest` in this container; use `cargo test -p
  wildflowerhealthio-fhir-r4 --test batch_bundle_at_base`, `cargo fmt
  --check`, `cargo clippy --tests -- -D warnings`.
- `persistBundle`'s whole-failure path reports every entry as
  `NO_RESPONSE_STATUS` ("No response") with the error string as its issue;
  HFS answers a refused transaction with an error for the bundle, so that is
  what a refused confirm shows. The results heading says "Nothing was
  imported" when nothing of what was attempted wrote.
- The stub servers in `referent-rows.test.tsx` and `importer-screen.test.tsx`
  must answer a search with resources of the searched type. The screen
  test's stub refuses a `transaction` one of whose PUT entries `failWrite`
  rejects as a whole (a 400, nothing stored, no entry recorded).
- Code-review subagents: `general-purpose`, model `opus`, told to invoke the
  `code-review` skill with `high --comment <pr>`; they report findings
  without severity markers, so triage them yourself.
- Ruth's review style: names first, types must earn their keep, errors
  bubble, no backwards compatibility, Effect data modules over hand loops,
  answer every comment. Every GitHub post ends with a blank line, `---`, and
  `_Generated by [Claude Code](https://claude.ai/code)_`.

## Current state

- `identity-map-screen-1419` at `b512ebd`, pushed, CI green, assigned Ruth.
- `linked-slot-1433` at `6e001ca`, pushed, draft PR #1435 on top of 1426.
- `ruths-machine/pages-publish-no-auto-gc`: PR #1434, green, assigned Ruth.
- Local checkout is on `linked-slot-1433`, clean.
- This file is committed on `claude/gallant-feynman-u1npzd` only.
