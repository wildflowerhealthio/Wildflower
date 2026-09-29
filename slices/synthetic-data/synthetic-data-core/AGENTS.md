# AGENTS.md — slices/synthetic-data/synthetic-data-core

The synthetic data set's pure core: the Ashford family's demographics and
dated stories, and one renderer per source that turns a story into the file
that source would produce. No DOM, no `fs`, no React.

## Namespaces

One namespace per module, in the `effect` style, from the flat root entry:
`import { Ashford, RexallHar } from 'synthetic-data-core'`.

- **`StoryDay`** (`src/story-day.ts`) — a day relative to the as-of date
  (`0` is the as-of day, `-30` a month before). `toDateTime` / `toIsoDate`
  date one; only the as-of instant's UTC calendar day matters (`asOfDayOf`).
- **`Seeded`** (`src/seeded.ts`) — `uuidOf`, `integerOf`, `digitsOf`: values
  hashed (FNV-1a) from the keys naming what they belong to, so adding a
  prescription leaves every other one's ids and times untouched.
- **`Person`** (`src/person.ts`) — demographics; `birthDateOf(person, asOf)`
  keeps the person `age` on every as-of day.
- **`DrugProduct`** (`src/drug-product.ts`) — a marketed product by DIN, and
  `catalogue`, the DPD-verified products the stories prescribe (the DIN table
  is its doc comment).
- **`Prescription`** (`src/prescription.ts`) — an Rx as a pharmacy holds it:
  product, dosing, supply per fill, repeats, prescriber, why it was `written`
  (`start`, `dose-change`, `renewal`, `resume`, `generic-switch`), when and why
  it `ended` (`dose-change`, `hold`, `generic-switch`, `stop`), and its
  `fillDays` (`fillDaysOnCadence` writes a refill cadence with days late). The
  sig, quantity per fill, daily dose, repeats remaining and status on the as-of
  day are all derived (`sigOf`, `quantityPerFillOf`, `dailyDoseOf`,
  `repeatsRemainingOf`, `statusOf`), so a renderer never restates the story.
  A medication episode is a drug's prescriptions read in order.
- **`LabDraw`** (`src/lab-draw.ts`) — a result a story's dose changes answer
  to (test, value, unit, day). Rendering labs is the lab source's job.
- **`Story`** (`src/story.ts`) — one person's record: `person`,
  `prescriptions`, `labDraws`.
- **`Ashford`** (`src/ashford/`) — the family (`warren`, `tyra`, `beau`,
  `fern`, `people`), `warrenStory` (its doc comment is the story, day by day)
  and `warrenRexallAccount`.
- **`ChromeHar`** (`src/har/chrome-har.ts`) — the HAR 1.2 envelope a Chrome
  DevTools export writes (pages, `_initiator` / `_resourceType`, phase
  timings, bodies as text in `content.text`): `pageOf`, `entryOf`,
  `archiveOf`, `toJson`. Every HAR renderer builds on it.
- **`RexallHar`** (`src/rexall/`) — `render(asOf, story, account)`: a
  letsbewell.ca session (sign-in page, prescriptions page, the profile XHR and
  the STU3 prescriptions searchset) as `.har` text. `carebook-profile.ts` and
  `carebook-searchset.ts` build the two bodies in the carebook dialect; each
  prescription is a `MedicationRequest` with its product contained, and its
  most recent fill a `MedicationDispense` sharing the request's `id`.

## Adding a source

A new source is a renderer module beside `rexall/` that reads `Story` values
(and the person's account on that source), builds the source's wire shape from
the source package's own constants, and — for HAR sources — wraps it with
`ChromeHar`. It ships with a round-trip test through the real importer that
asserts the story, not the renderer's own output, comes back.

## Layering

Depends on `effect`, `kitchen-sink` (`fnv1a64`, `utf8Bytes`) and
`rexall-be-well-source` (the carebook extension, identifier and coding
catalogue — spelled once, there). The importers and readers the round-trip
tests drive (`har-importer-core`, `importer-fundamentals`, `http-archive`,
`medication-core`, `fhir-r4`) are dev dependencies only. Never imports a
`-react`, `-node` or `-tauri` package.

## Testing

- `src/ashford/warren.test.ts` — Warren's story against the epic's numbers:
  doses, the order of events, the lab values that drive them, cadence, and the
  18-month window.
- `src/rexall/rexall-har.test.ts` — properties over the as-of date: byte-identical
  renders within a day, every timestamp shifting with the as-of date, and an
  archive `http-archive` decodes.
- `src/rexall/rexall-har.round-trip.test.ts` — the HAR through
  `harImporter.decode`, then `medication-core`: names, DINs, quantities, supply,
  repeats, statuses, sigs, dispenses and the amortized daily doses, written out
  from the epic.

## References

- [slices/synthetic-data/AGENTS.md](../AGENTS.md) — the slice, the family and its rules.
- [rexall-be-well-source AGENTS.md](../../http-extraction/rexall-be-well-source/AGENTS.md)
  — the dialect the Rexall renderer writes, and what its promotion reads.
- [Property Testing Reference](../../../docs/Testing/Property%20Testing%20Reference.md)
