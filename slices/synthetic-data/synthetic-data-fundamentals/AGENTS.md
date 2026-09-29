# AGENTS.md — slices/synthetic-data/synthetic-data-fundamentals

The base every synthetic data generator builds on: the story model, the
deterministic values a generator draws from it, and the defaults a generated
browser capture is written with. No source is named here — a
`synthetic-data-<source>` package turns a `Story` into that source's files. No
DOM, no `fs`, no React. The stories themselves, and the products they
prescribe, live in
[`wildflowerhealthio/synthetic-data`](https://github.com/wildflowerhealthio/synthetic-data).

## Sub-entries

The root exports nothing; the surface is three sub-entries plus
`test-helpers`. Each module is a namespace in the `effect` style: the file is
the noun, the principal type shares the namespace's name
(`Prescription.Prescription`), and functions read in the namespace's context
(`Prescription.statusOf`).

### `synthetic-data-fundamentals/story` — the story model

`import { Prescription, StoryDay } from 'synthetic-data-fundamentals/story'`
(`src/story/`).

- **`StoryDay`** (`src/story/story-day.ts`) — a day relative to the as-of date
  (`0` is the as-of day, `-30` a month before). `toDateTime` / `toIsoDate`
  date one; only the as-of instant's UTC calendar day matters (`asOfDayOf`).
  `instantOn(asOf, storyDay, keys, fromHourUtc, toHourUtc)` is the time of day
  an event on that day happened: a second in the UTC hour window, hashed from
  `keys` through `Seeding`, never off the day.
- **`Person`** (`src/story/person.ts`) — demographics as a story holds them: a
  key, given and family name, `fhir-r4`'s `AdministrativeGender`, an `age` and
  `daysSinceBirthday` rather than a birth date, a fictional email and postal
  code. `birthDateOf(person, asOf)` keeps the person `age` on every as-of day.
- **`DrugProduct`** (`src/story/drug-product.ts`) — the type of a marketed
  product by DIN (DPD keys, brand, generic name, strength, form, company), and
  the labels a pharmacy prints for it (`labelOf`, `strengthLabelOf`). No
  products: a data set's chosen, verified products are the data repo's.
- **`Prescription`** (`src/story/prescription.ts`) — an Rx as a pharmacy holds
  it: product, dosing, supply per fill, repeats, prescriber, why it was
  `written` (`start`, `dose-change`, `renewal`, `resume`, `generic-switch`),
  when and why it `ended` (`dose-change`, `hold`, `generic-switch`, `stop`),
  and its `fillDays` (`fillDaysOnCadence` writes a refill cadence with days
  late). The sig, quantity per fill, daily dose, repeats remaining and status
  on the as-of day are all derived (`sigOf`, `quantityPerFillOf`,
  `dailyDoseOf`, `repeatsRemainingOf`, `statusOf`), so a generator never
  restates the story. A medication episode is a drug's prescriptions read in
  order.
- **`LabDraw`** (`src/story/lab-draw.ts`) — a result a story's dose changes
  answer to (test, value, unit, day). Printing and coding it is the lab
  source's job.
- **`Story`** (`src/story/story.ts`) — one person's record: `person`,
  `prescriptions`, `labDraws`.

### `synthetic-data-fundamentals/seeding` — deterministic values

`import * as Seeding from 'synthetic-data-fundamentals/seeding'`
(`src/seeding.ts`). `uuidOf`, `integerOf`, `digitsOf`: values hashed
(`kitchen-sink`'s `fnv1a64` over `fhir-r4`'s `joinIdComponents`, then
`kitchen-sink`'s `fmix64`) from the keys naming what they belong to, so adding a prescription leaves every
other one's ids and times untouched.

### `synthetic-data-fundamentals/chrome-har` — Chrome capture defaults

`import * as ChromeHar from 'synthetic-data-fundamentals/chrome-har'`
(`src/chrome-har.ts`). A synthetic Chrome DevTools capture as `http-archive`
values: `pageOf` → `HarPage`, `entryOf` → a `ChromeHarEntry` (always a `200`
`GET`, the body as a `HarTextBody`, fixed phase timings around the chosen
`wait`), `archiveOf` → a `ChromeHar` under the `WebInspector` creator, and
`toJson` → the two-space-indented `.har` text through `chromeHarToJson`.
`ResourceType` (`document` | `xhr`) decides each entry's `_initiator`
(`other` / `script`) and `_priority` (`VeryHigh` / `High`), which `Entry`
narrows to those literals.

### `synthetic-data-fundamentals/test-helpers`

`src/test-helpers.ts`: the fast-check arbitraries — as-of instants, people,
products (plausible 8-digit DINs, strengths, manufacturers), dosings,
prescribers, and `storyCaseArbitrary`, which lays out one to four drug
episodes — a start, then dose changes, renewals once the repeats run out,
holds and resumes, generic switches — with on-time, late and missed refills,
shifted to end before the as-of day. Each story comes paired with what its
pharmacy records must say (name, DIN, quantity, supply, repeats, status, sig,
last fill, amortized daily dose), worked out from the generated inputs rather
than by the model functions a generator calls, so a generator's round-trip
test compares an importer's output against an independent reckoning.

## Layering

Depends on `effect`, `kitchen-sink` (`fnv1a64`, `fmix64`, `utf8Bytes`), `fhir-r4`
(`joinIdComponents`, the key fold `Seeding` hashes, and `AdministrativeGender`)
and `http-archive` (the HAR schema `ChromeHar` builds). It imports no source
package and no importer: which source a story is written for, and the round
trip through that source's importer, are the generator package's. Never
imports a `-react`, `-node` or `-tauri` package.

## Rules

- **Nothing here reads the clock.** Every date is a `StoryDay` against an
  as-of instant the caller passes, and every value a real system would draw
  at random goes through `Seeding`.
- **Wire shapes are their format packages'.** `ChromeHar` holds only the
  synthetic defaults; the HAR structure, the DevTools extras and the JSON text
  are `http-archive`'s. A shape a generator needs that `http-archive` or
  `fhir-r4` lacks is added there, not declared here.
- **Stories are generated in tests.** Everything is property-tested over the
  `test-helpers` arbitraries; a named person or a chosen product belongs in
  the data repo.

## Traps

- **`package.json` `exports` and `vite.config.ts` `pack.entry` must stay in
  sync** (`index`, `chrome-har`, `seeding`, `story/index`, `test-helpers`). A missing entry silently ships no dist for
  that subpath and only fails downstream on a fresh `vp run pack`.
- **`Seeding` values are pinned.** Every published id is hashed through it, so
  a change to the hash re-keys a whole data set; `seeding.test.ts` pins one
  value so that fails loudly.
- **`_initiator` / `_priority` / `_resourceType` are read with
  `no-underscore-dangle` disabled** for the file, with a reason, as
  `http-archive`'s own tests do; writing them in an object literal needs no
  disable.

## References

- [slices/synthetic-data/AGENTS.md](../AGENTS.md) — the slice and its packages.
- [http-archive AGENTS.md](../../file-formats/http-archive/AGENTS.md) — the
  HAR schema `ChromeHar` builds.
- [Property Testing Reference](../../../docs/Testing/Property%20Testing%20Reference.md)
  — property tests are the default here.
