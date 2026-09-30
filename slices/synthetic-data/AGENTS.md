# AGENTS.md — slices/synthetic-data

The **synthetic data tooling**: a model for dated health stories — people,
prescriptions and their fills, lab draws — and generators that turn a story
into the files each real source would produce, proven by reading them back
through Wildflower's own importers, so generated data looks exactly like an
import would.

This slice holds **tooling only**. The stories themselves — the fictional
people, their narratives, the accounts they are filled under and the chosen,
DPD-verified drug products — live in the data repo,
[`wildflowerhealthio/synthetic-data`](https://github.com/wildflowerhealthio/synthetic-data),
which generates its data set with these packages and publishes the output.
Nothing here names a person or tells a particular story.

## Packages

The slice is layered like `health-viewer`: a source-free base, with one
generator package per source on top of it.

- **`synthetic-data-fundamentals`** (pure) — the source-free base. Its root
  exports nothing; it has one sub-entry per role:
  - **Story model** — `synthetic-data-fundamentals/story`: the base domain
    objects a data set's narrative is written in and a renderer reads, as
    `effect`-style namespaces — `Story`, `Person`, `Prescription`,
    `DrugProduct`, `LabDraw`, and `StoryDay` (days relative to the as-of
    date, and `instantOn` for the time of day an event happens).
    `import { Prescription, StoryDay } from 'synthetic-data-fundamentals/story'`.
  - **Deterministic values** — `synthetic-data-fundamentals/seeding`: ids and
    numbers hashed from the keys naming what they belong to, with
    `kitchen-sink`'s `fnv1a64` and `fmix64` over `fhir-r4`'s
    `joinIdComponents`.
    `import * as Seeding from 'synthetic-data-fundamentals/seeding'`.
  - **Chrome capture defaults** — `synthetic-data-fundamentals/chrome-har`:
    the synthetic defaults a generated Chrome DevTools capture's entries are
    written with; the format, the DevTools vocabulary and the page and archive
    builders are `http-archive`'s.
    `import * as ChromeHar from 'synthetic-data-fundamentals/chrome-har'`.

  Its `./test-helpers` subpath holds the fast-check arbitraries every
  generator's tests draw stories from. See its
  [AGENTS.md](./synthetic-data-fundamentals/AGENTS.md).

- **`synthetic-data-rexall-be-well`** (pure) — `RexallHar.render`: a `Story`,
  filled under a `RexallAccount`, as the HAR a letsbewell.ca session exports
  (the carebook profile and the STU3 prescriptions searchset), written as
  `rexall-be-well-source`'s schemas encode them. Its `./test-helpers` subpath
  holds `rexallAccountArbitrary`. See its
  [AGENTS.md](./synthetic-data-rexall-be-well/AGENTS.md).

- **`synthetic-data-shoppers-drugmart`** (pure) — `ShoppersHar.render`: a
  family `ShoppersAccount`, each managed person with a `Story`, as the HAR a
  mypharmacy.shoppersdrugmart.ca session exports (the customers body, a
  prescription-status body per prescription, and the prescription history),
  written as `shoppers-drugmart-source`'s schemas encode them. Its
  `./test-helpers` subpath holds `shoppersCaseArbitrary`. See its
  [AGENTS.md](./synthetic-data-shoppers-drugmart/AGENTS.md).

- **`synthetic-data-lifelabs`** (pure) — `LifeLabs.render`: a `Story`'s lab
  draws, printed by a `Laboratory`, as the FHIR resources the LifeLabs PDF
  import makes of the reports (`lifelabs-pdf-importer-core/synthesis`), filed
  on the Patient the person's pharmacy import made. Its `./story` subpath
  holds the `Laboratory`, `PrintedRange` and `LabRequisition` a data set
  writes beside the story; its `./test-helpers` subpath holds
  `laboratoryArbitrary` and the lab-draw arbitraries. See its
  [AGENTS.md](./synthetic-data-lifelabs/AGENTS.md).

- **`synthetic-data-fhir-sync-pebble`** (pure) — `PebbleObservations.render`:
  a `Physiology` (resting heart rate, walks, nights and charging, per
  `StoryDay`) as the heart-rate, steps and movement minute history and the
  sleep and walk activity Observations the FHIR Sync for Pebble app writes,
  built by `fhir-sync-pebble-core`'s own `WatchSync`. Its `./test-helpers`
  subpath holds `physiologyCaseArbitrary`. See its
  [AGENTS.md](./synthetic-data-fhir-sync-pebble/AGENTS.md).

A generator for a source is a `synthetic-data-<source>` package on top of
`synthetic-data-fundamentals`: it reads `Story` values, plus the person's
account on that source, and writes the source's own wire shape, spelled from
that source package's constants.
A pharmacy generator also names the Patient its import makes of a person
(`rexallPatientReferenceOf`, `shoppersPatientReferenceOf`), so another
source's results — lab results — are filed on the same Patient.

## Rules

- **Every date is relative to an as-of date.** Stories are written in
  `StoryDay`s (days from the as-of day) and turned into calendar dates only
  when generated, so a regenerated data set tells the same story on new dates.
  Nothing reads the clock.
- **Generation is deterministic.** The same as-of day gives byte-identical
  output. Values a real system would draw at random (ids, prescription
  numbers, times of day) are hashed from the names of what they belong to
  (`Seeding`, `StoryDay.instantOn`), and jitter never moves an event off the
  day its story sets.
- **Formats are their own packages'.** A generator builds `http-archive`
  values (its entries through `synthetic-data-fundamentals/chrome-har`, its
  pages and archive with `http-archive`'s `chromePageOf` / `chromeHarOf`) and
  FHIR shapes from `fhir-r4`; it declares no wire type another package already
  owns.
- **Generate what the source sends, then import it.** A generator writes the
  source's own wire shape (modelled on that source package's anonymized
  fixtures, spelled from its constants), and a round-trip test runs generated
  stories through the real importer and asserts each one comes out as its
  generated inputs say.
- **No narrative here.** Tests generate their stories (fast-check); a
  hand-written example inside a test is fine, a named person or a chosen
  product catalogue is not — those belong in the data repo.

## References

- [Architecture / slice layering](../AGENTS.md)
- [health-viewer AGENTS.md](../health-viewer/AGENTS.md) — the structure this
  slice mirrors.
- [http-archive AGENTS.md](../file-formats/http-archive/AGENTS.md) — the HAR
  format and DevTools vocabulary every capture is built on.
- [Property Testing Reference](../../docs/Testing/Property%20Testing%20Reference.md)
  — property tests are the default here.
