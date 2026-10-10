# AGENTS.md — apps/synthetic-data/synthetic-data-fundamentals

The base every synthetic data generator builds on, in three roles, each a
sub-entry:

- **the story model** (`/story`) — the base domain objects a data set's
  narrative is written in and a renderer reads;
- **deterministic values** (`/seeding`) — the ids, numbers and times a real
  system would draw at random, hashed from what they belong to;
- **Chrome capture defaults** (`/chrome-har`) — what a generated Chrome
  DevTools capture is written with, on `http-archive`'s format.

No source is named here — a `synthetic-data-<source>` package turns a `Story`
into that source's files. No DOM, no `fs`, no React. The stories themselves,
and the products they prescribe, live in
[`wildflowerhealthio/synthetic-data`](https://github.com/wildflowerhealthio/synthetic-data).

## Sub-entries

The root exports nothing; `package.json` `exports` is the surface. Each module
is a namespace in the `effect` style: the file is the noun, the principal type
shares the namespace's name (`Prescription.Prescription`), and functions read
in the namespace's context (`Prescription.statusOf`).

### Story model — `synthetic-data-fundamentals/story`

`import { Prescription, StoryDay } from '@wildflowerhealthio/synthetic-data-fundamentals/story'`
(`src/story/`). Owns the domain objects; borrows `AdministrativeGender` from
`fhir-r4` and draws times of day through `Seeding`.

- **`Story`** (`src/story/story.ts`) — the root: one person's record,
  `person`, `prescriptions`, `labDraws`.
- **`StoryDay`** (`src/story/story-day.ts`) — the model's calendar: a day
  relative to the as-of date (`0` is the as-of day, `-30` a month before).
  `toDateTime` / `toIsoDate` date one; only the as-of instant's UTC calendar
  day matters (`asOfDayOf`). `instantOn` is the time of day an event on that
  day happened: a second in the UTC hour window `[fromHourUtc, toHourUtc)`,
  hashed from `keys`, never off the day.
- **`Person`** (`src/story/person.ts`) — demographics as a story holds them: a
  key, given and family name, `AdministrativeGender`, an `age` and
  `daysSinceBirthday` rather than a birth date, a fictional email and postal
  code. `birthDateOf(person, asOf)` keeps the person `age` on every as-of day.
- **`DrugProduct`** (`src/story/drug-product.ts`) — the marketed product a
  `Prescription` points at, by DIN (DPD keys, brand, generic name, strength,
  form, company), and the labels a pharmacy prints for it (`labelOf`,
  `strengthLabelOf`). No products: a data set's chosen, verified catalogue is
  the data repo's.
- **`Prescription`** (`src/story/prescription.ts`) — an Rx as a pharmacy holds
  it: product, dosing, supply per fill, repeats, prescriber, why it was
  `written` (`start`, `dose-change`, `renewal`, `resume`, `generic-switch`),
  when and why it `ended` (`dose-change`, `hold`, `generic-switch`, `stop`),
  and its `fillDays` (`fillDaysOnCadence` writes a refill cadence with days
  late). The sig, quantity per fill, daily dose, repeats remaining and status
  on the as-of day are all derived (`sigOf`, `quantityPerFillOf`,
  `dailyDoseOf`, `repeatsRemainingOf`, `statusOf`), so a renderer never
  restates the story. A medication episode is a drug's prescriptions read in
  order.
- **`LabDraw`** (`src/story/lab-draw.ts`) — a result a story's dose changes
  answer to (test, value, unit, day). Printing and coding it is the lab
  source's renderer's job.

### Deterministic values — `synthetic-data-fundamentals/seeding`

`import * as Seeding from '@wildflowerhealthio/synthetic-data-fundamentals/seeding'`
(`src/seeding.ts`). `uuidOf`, `integerOf`, `digitsOf`: values hashed from the
keys naming what they belong to, so adding a prescription leaves every other
one's ids and times untouched.

- **Borrows** the hash: `fhir-r4/identity`'s `joinIdComponents` folds the
  keys (the fold `localResourceId` hashes), `kitchen-sink`'s `fnv1a64` hashes
  them from `FNV_1A_64_OFFSET_BASIS`, and `kitchen-sink`'s `fmix64` spreads
  each lane so sibling keys (`…-1`, `…-2`) differ in about half their bits.
- **Owns** the second-lane basis (the standard basis xored with the ASCII of
  `"wildflwr"`) and the shaping: a version-4-shaped UUID from two lanes, an
  integer in a range, a run of digits with no leading zero.
- `fhir-r4`'s `localResourceId` is the same two-lane scheme with a different
  second-lane constant; it is not called because it yields an unmixed,
  `wf-`-prefixed store key, where a generated id reads like a vendor's GUID.

### Chrome capture defaults — `synthetic-data-fundamentals/chrome-har`

`import * as ChromeHar from '@wildflowerhealthio/synthetic-data-fundamentals/chrome-har'`
(`src/chrome-har.ts`).

- **Owns** only what is synthetic: `ExchangeSpec` and `entryOf`, which writes
  a `ChromeHarEntry` that is always a `200` `GET` over a reused HTTP/2
  connection (`connection: '0'`, no DNS, connect or TLS phases), with fixed
  phase timings around the chosen `wait` and the body as a `HarTextBody`.
  `NavigationSpec` and `navigationEntryOf` write a page navigation on top of
  it: a `document` fetch of a single-page app's empty shell, which no
  response kind claims.
- **Borrows** everything else from `http-archive`: the format
  (`ChromeHarEntry`, `chromeHarToJson`), the DevTools vocabulary
  (`ChromeResourceType`, and `chromeExtrasOf`, which `entryOf` uses for
  `_initiator` / `_priority` / `_resourceType`), and the page and archive
  builders. Callers take those from `http-archive` directly — this sub-entry
  does not re-export them:

  ```ts
  import { Effect } from 'effect'
  import { chromeHarOf, chromeHarToJson, chromePageOf } from '@wildflowerhealthio/http-archive'
  import * as ChromeHar from '@wildflowerhealthio/synthetic-data-fundamentals/chrome-har'

  const archive = chromeHarOf(pages.map(chromePageOf), exchanges.map(ChromeHar.entryOf))
  const text = Effect.runSync(chromeHarToJson(archive, { pretty: true }))
  ```

### `synthetic-data-fundamentals/test-helpers`

`src/test-helpers.ts`: the fast-check arbitraries — as-of instants, people,
products (plausible 8-digit DINs, strengths, manufacturers), dosings,
prescribers, and `storyCaseArbitrary`, which lays out one to four drug
episodes, each drug under its own generic name — a start, then dose changes, renewals once the repeats run out,
holds and resumes, generic switches — with on-time, late and missed refills,
shifted to end before the as-of day. Each story comes paired with what its
pharmacy records must say (name, DIN, quantity, supply, repeats, status, sig,
last fill, amortized daily dose, and the keys of the prescriptions before and
after it in its episode), worked out from the generated inputs rather
than by the model functions a generator calls, so a generator's round-trip
test compares an importer's output against an independent reckoning.

## Layering

Depends on `effect`, `kitchen-sink` (`fnv1a64`, `FNV_1A_64_OFFSET_BASIS`,
`fmix64` for `Seeding`; `utf8Bytes` for `ChromeHar`), `fhir-r4`
(`joinIdComponents` for `Seeding`; `AdministrativeGender` for `Person`) and
`http-archive` (the HAR format and DevTools vocabulary `ChromeHar` writes
with). It imports no source package and no importer: which source a story is
written for, and the round trip through that source's importer, are the
generator package's. Never imports a `-react`, `-node` or `-tauri` package.

## Rules

- **Nothing here reads the clock.** Every date is a `StoryDay` against an
  as-of instant the caller passes, and every value a real system would draw
  at random goes through `Seeding`.
- **Wire shapes are their format packages'.** `ChromeHar` holds only the
  synthetic defaults; the HAR structure, the DevTools vocabulary and the JSON
  text are `http-archive`'s. A shape a generator needs that `http-archive` or
  `fhir-r4` lacks is added there, not declared here.
- **Stories are generated in tests.** Everything is property-tested over the
  `test-helpers` arbitraries; a named person or a chosen product belongs in
  the data repo.

## Traps

- **`package.json` `exports` and `vite.config.ts` `pack.entry` must stay in
  sync** (`index`, `chrome-har`, `seeding`, `story/index`, `test-helpers`). A
  missing entry silently ships no dist for that subpath and only fails
  downstream on a fresh `vp run pack`.
- **`Seeding` values are pinned.** Every published id is hashed through it, so
  a change to the hash re-keys a whole data set; `seeding.test.ts` pins one
  value so that fails loudly.
- **`_initiator` / `_priority` / `_resourceType` are read with
  `no-underscore-dangle` disabled** for the file, with a reason, as
  `http-archive`'s own tests do; writing them in an object literal needs no
  disable.

## References

- [apps/synthetic-data/AGENTS.md](../AGENTS.md) — the slice and its packages.
- [http-archive AGENTS.md](../../../slices/file-formats/http-archive/AGENTS.md) — the
  HAR format and DevTools vocabulary `ChromeHar` writes with.
- [Property Testing Reference](../../../docs/Testing/Property%20Testing%20Reference.md)
  — property tests are the default here.
