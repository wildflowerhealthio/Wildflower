# Handoff

## What we're doing and why

Add **drug-interaction checking** to the medications product: a new
`medication-interaction` slice plus integration into `apps/medications-app`.
Interactions come from the **DDInter** database
(<https://ddinter.scbdd.com/download/>) and are shown in three groups:

1. **Interactions between known drugs** — any two medications in the patient's
   FHIR `MedicationRequest` list that DDInter lists as interacting.
2. **Interactions with non-drugs** (food, alcohol, caffeine, …) — _only if DDInter
   carries such entries_; otherwise ship the group empty with a note. (DDInter is
   believed to be drug–drug only.)
3. **Interactions with common OTC drugs** — each patient medication checked
   against a curated list of common Canadian OTC actives that lives in core.

### Decisions the user has already made (do not re-ask)

| Question              | Decision                                                                                                                                                                                                                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data access           | User allowlists `ddinter.scbdd.com`; agent fetches the files in-session                                                                                                                                                                                                                                                               |
| Non-drug group source | Whatever DDInter has; else skip (empty group + note)                                                                                                                                                                                                                                                                                  |
| Slice layout          | **New slice** `slices/medication-interaction/` with `medication-interaction-core` + `medication-interaction-react`, mirroring `medication-sponsorship`                                                                                                                                                                                |
| Data size             | **Bundle the full set** in a compact encoding (convert CSVs at build/commit time; no runtime fetch, no ATC chunking, no trimming)                                                                                                                                                                                                     |
| OTC list              | Curated JSON in core (~30–50 common Canadian OTC actives: acetaminophen, ibuprofen, naproxen, ASA, diphenhydramine, loratadine, cetirizine, omeprazole, famotidine, pseudoephedrine, dextromethorphan, melatonin, St John's wort, etc.)                                                                                               |
| UI placement          | **Separate tab/route**: a toggle in the app header between "Medications" and "Interactions"                                                                                                                                                                                                                                           |
| Matching              | **Reuse the sponsorship fuzzy matcher** — lift `normalizeName`/`tokenize` and the exact/strong/partial scoring out of `medication-sponsorship-core` into a shared spot (small shared package, or `kitchen-sink`) so both slices use it; multi-ingredient meds match each DDInter drug whose name is contained in the med display name |
| Ready to start?       | Yes                                                                                                                                                                                                                                                                                                                                   |

## What's done

**No code has been written.** The session was spent on orientation and
clarifying questions. What exists:

- The branch `claude/medication-interaction-checking-mxcbbl` (clean, tracks origin).
- Orientation of the medication slice and app (summarised below).
- Confirmation that DDInter's host is **blocked by the egress proxy** in the
  previous session, even after the user said they had allowlisted it.

## What remains

Everything. Suggested order:

1. **Fetch DDInter.** `curl -L https://ddinter.scbdd.com/download/` and follow the
   links. Expected (from memory — verify): per-ATC-letter CSVs
   (`ddinter_downloads_code_A.csv`, `_B`, `_D`, `_H`, `_L`, `_P`, `_R`, `_V`) with
   columns `DDInterID_A, Drug_A, DDInterID_B, Drug_B, Level` where `Level` is
   `Major | Moderate | Minor | Unknown`. ~236k pairs, ~1.8k drugs. There is no
   mechanism/management text in the download; the DDInter site has a per-pair
   detail page that the UI can link to. Record the licence/terms found on the page
   in the slice README. Check whether any drug names are food/alcohol/caffeine
   (e.g. `Ethanol`, `Caffeine`, `Grapefruit`) — that decides whether group 2 has data.
   If the host is still blocked, ask the user to commit the CSVs or start yet
   another session; **do not** build around the block silently.
2. **Compact encoding + conversion script.** Write a script (run as a temporary
   `*.test.ts` through `vp test`, or a `scripts/` node script — `node` directly
   can't resolve workspace packages) that turns the CSVs into a compact JSON:
   a drug table (`id → name`) plus a pair list of `[indexA, indexB, level]`.
   Dedupe pairs that appear in several ATC files. Commit the generated JSON under
   `apps/medications-app/src/data/ddinter/` (matching how `innovicares.json` /
   `rxhelp.json` are bundled) and document the regeneration command.
3. **`medication-interaction-core`** (pure, FHIR-agnostic, Effect `Schema`):
   - `ddinter.ts`: raw-file schema + decoder to an `InteractionCatalog`
     (drug lookup + severity-indexed pair map).
   - `severity.ts`: `Severity` literal + labels + sort rank (Major > Moderate > Minor > Unknown).
   - `otc.ts`: curated OTC list (name + optional note), exported as data.
   - `match.ts`: map a `Medication` (same minimal shape as sponsorship's) to zero
     or more DDInter drug ids via the shared fuzzy matcher.
   - `group.ts`: `findInteractions(medications, catalog, otcList)` →
     `{ knownDrugs, nonDrugs, otc }` groups, each row `{ a, b, severity, url }`,
     sorted by severity then name; known-drug pairs deduped (unordered).
   - Property tests with fast-check for symmetry, dedupe, sort order, idempotent
     normalization (see `docs/Testing/Property Testing Reference.md`).
4. **Shared matcher extraction.** Move `normalize.ts` and the scoring half of
   `match.ts` from `medication-sponsorship-core` to a shared location and re-export
   from sponsorship so its public API is unchanged. Keep sponsorship's tests green.
   `kitchen-sink` is the existing shared utility package (a peer dep of sponsorship-core).
5. **`medication-interaction-react`**: `InteractionsView` with three sections,
   severity badge, DDInter link per row, empty-state text for the non-drug group.
   Reuse the sponsorship react package's CSS-module conventions and its
   `MedicationRequest → Medication` adapter (`medication.ts` there exports
   `medicationRequestsToMedicationViews`; the `Medication` value inside a view is
   the matching input).
6. **App integration** in `apps/medications-app/src/app.tsx`: header toggle
   ("Medications" | "Interactions"), decode the bundled DDInter JSON once in a
   `catalogs.ts`-style module, pass the loaded views to `InteractionsView`.
   Add tests beside `app.test.tsx` / `catalogs.test.ts`.
7. **Docs**: `slices/medication-interaction/AGENTS.md` (mirror sponsorship's),
   update `slices/AGENTS.md` slice list, `apps/medications-app/README.md`,
   `slices/medication-sponsorship/AGENTS.md` if the matcher moves.
8. `vp install` after adding packages, `vp run pack`, `vp run ready`, then commit,
   push with `git push -u origin claude/medication-interaction-checking-mxcbbl`,
   open a **draft PR**. Read `docs/Agents/Review Standards Reference.md` first.

## Key files to read first

- `slices/medication-sponsorship/AGENTS.md` — the slice this one mirrors.
- `slices/medication-sponsorship/medication-sponsorship-core/src/{normalize,match,group,sponsor}.ts` — the matcher to share and the shape/grouping patterns to copy.
- `slices/medication-sponsorship/medication-sponsorship-react/src/medication.ts` — the FHIR `MedicationRequest` → `Medication` adapter (already handles carebook/Shoppers DIN dialects).
- `apps/medications-app/src/app.tsx` and `src/catalogs.ts` — where the tab and bundled catalog go.
- `apps/medications-app/README.md` — boot structure and where the bundle is served.
- Required reading per `CLAUDE.md`: `docs/Testing/Testing Reference.md`, `docs/Documentation/Doc Comments Reference.md`, `docs/Agents/Review Standards Reference.md`, `docs/Agents/Strategies.md`, `docs/Agents/Learnings Inbox.md`.

## Gotchas and context the next agent needs

- **Egress block.** `ddinter.scbdd.com` returned 403 on CONNECT from the egress
  gateway three times, including after the user allowlisted it. Environment
  network policy is most likely read at container start, so a _fresh session_
  should see the new policy. Verify with
  `curl -sS "$HTTPS_PROXY/__agentproxy/status"` (shows `recentRelayFailures`).
  The download links may point at a different host/subdomain — that host would
  need allowlisting too.
- **Never invoke `pnpm`/`npm` directly** — everything via `vp`. Run `vp run pack`
  before `vp check` / workspace-wide `vp test` on a fresh container, otherwise
  hundreds of unrelated failures from missing `dist/`.
- **Test utilities import from `vite-plus/test`**, not `vitest`. Use the
  `/javascript-testing-expert` skill when writing tests; property tests are the
  default in this slice family.
- **Slice layering**: `-core` is pure (no DOM, no FHIR, no fs). FHIR mapping lives
  in `-react`. The core `Medication` type is `{ id, displayName, status?, authoredOn? }`.
- **Decoded FHIR resources** carry `URL` objects in `uri` slots, not strings —
  the sponsorship adapter already coerces via `nullableUri`; reuse it rather than
  re-decoding.
- **New package boilerplate**: copy `package.json` / `vite.config.ts` /
  `tsconfig.json` from `medication-sponsorship-core` and `-react` (core uses
  `platform: 'neutral'`, `dts: { tsgo: true }`, `exports` with `source` + `default: ./dist`).
  Run `vp install` after adding them.
- **No `any` / casts**. Surface any unavoidable cast in the PR description.
- **Branch naming** for the PR is fixed by the task: keep working on
  `claude/medication-interaction-checking-mxcbbl`.
- The user asked for questions up front and has answered them (table above);
  they said "Yes, go". Don't re-run the clarification cycle unless the DDInter
  data turns out materially different from the expected shape.

## Current state

- Branch: `claude/medication-interaction-checking-mxcbbl`, checked out, up to date
  with `origin`, **clean working tree** apart from this `Handoff.md` and the
  Learnings Inbox entry.
- Nothing staged, nothing committed this session.
- No PR exists for the branch yet.
