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

Everything except the data. All of it is committed on the branch and green
(`vp check`, `vp run lint:docs`, `vp run test:changed`):

- **`slices/medication-matching/medication-matching-core`** — the sponsorship
  matcher's fundamentals extracted (`Medication` type, `normalizeName` /
  `tokenize`, `scoreName` + `confidenceRank` + `isTokenSubset`).
  `medication-sponsorship-core` builds on it and re-exports the same public API.
- **`slices/medication-interaction/medication-interaction-core`** — `DdinterFile`
  compact schema + `decodeDdinterFile` → `InteractionCatalog`; `parseDdinterCsv`
  / `buildDdinterFile` converter; severity model; `otcDrugs`, `nonDrugNames`;
  `matchCatalogDrugs`; `findInteractions` (three groups). Property tests throughout.
- **`medication-interaction-react`** — `InteractionsView` (three sections,
  `StatusBadge` severity, "Details" link per row), `SeverityBadge`.
- **`apps/medications-app`** — header toggle Medications | Interactions
  (`TabToggle` in `app.tsx`; province picker only on the medications view;
  interactions over _active_ meds), `src/interaction-catalog.ts`,
  `scripts/convert-ddinter.ts` (`vp run -F medications-app data:ddinter -- <dir>`,
  smoke-tested on a synthetic CSV directory), tests, README.
- Docs: `slices/medication-interaction/AGENTS.md`, `slices/medication-matching/AGENTS.md`,
  `slices/AGENTS.md`, sponsorship AGENTS.md, Learnings Inbox entries.
- Draft PR #565 describes the state.

## What remains

1. **Get the DDInter CSVs.** `ddinter.scbdd.com` was _still_ blocked by the
   egress proxy in the second session (403 on CONNECT, via both `curl` and
   `WebFetch`), so no data has been fetched. Either allowlist the host in the
   environment's network policy and start a fresh session, or download
   `ddinter_downloads_code_*.csv` locally and commit them / run the script.
2. **Generate the bundle**: `vp run -F medications-app data:ddinter -- <dir>`
   overwrites `apps/medications-app/src/data/ddinter/ddinter.json` (currently the
   empty placeholder; the Interactions view shows a "no database bundled" notice).
   The converter throws on any column / `Level` it does not recognise — if it
   does, the CSV shape differs from the assumed
   `DDInterID_A, Drug_A, DDInterID_B, Drug_B, Level`; adjust `ddinter-csv.ts`.
3. **Verify two assumptions against the live site** and fix in one place each:
   the drug-detail URL scheme in `medication-interaction-core/src/ddinter.ts`
   (`ddinterDrugUrl`), and DDInter's licence / terms (record in the slice
   `AGENTS.md`). Also check which `nonDrugNames` entries DDInter actually carries
   (`Caffeine`, `Ethanol`, …) — that decides whether group 2 has data.
4. Look at the real matching quality once data is in (brand names such as
   `Tylenol` do not match DDInter's generic names — expected, documented).
5. Delete this file in the final commit; flip PR #565 from draft after reading
   `docs/Agents/Review Standards Reference.md`.

## Gotchas and context the next agent needs

- **Egress block.** Environment network policy is read at container start; a
  mid-session allowlist change does not take effect. Verify with
  `curl -sS "$HTTPS_PROXY/__agentproxy/status"` (`recentRelayFailures`).
- **Never invoke `pnpm`/`npm` directly** — everything via `vp`. Run `vp run pack`
  before `vp check` / workspace-wide `vp test` on a fresh container.
- **Run a single package's tests from inside its directory** (`cd <pkg> && vp test`);
  `vp test --config <pkg>/vite.config.ts` from the root finds no files.
- **The compact JSON is excluded from `vp fmt`** (root `vite.config.ts`
  `fmt.ignorePatterns`) — it is single-line and must stay generated.
- **`vp run … -- <dir>` forwards the `--`** to the script; `convert-ddinter.ts`
  filters it out.
- **No `any` / casts.** None were needed; keep it that way.
