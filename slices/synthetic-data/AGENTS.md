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

- **`synthetic-data-fundamentals`** (pure) — the story model as `effect`-style
  namespaces from one flat entry: `Story`, `Person`, `Prescription`,
  `DrugProduct`, `LabDraw`, `StoryDay` (days relative to the as-of date, and
  `instantOn` for the time of day an event happens), `Seeded` (deterministic
  ids and numbers) and `HarCapture` (the synthetic defaults a generated Chrome
  DevTools capture is built with, on `http-archive`'s `ChromeHar`). Its
  `./test-helpers` subpath holds the fast-check arbitraries every generator's
  tests draw stories from. See its
  [AGENTS.md](./synthetic-data-fundamentals/AGENTS.md).

A generator for a source is a `synthetic-data-<source>` package on top of
`synthetic-data-fundamentals`: it reads `Story` values, plus the person's
account on that source, and writes the source's own wire shape, spelled from
that source package's constants.

## Rules

- **Every date is relative to an as-of date.** Stories are written in
  `StoryDay`s (days from the as-of day) and turned into calendar dates only
  when generated, so a regenerated data set tells the same story on new dates.
  Nothing reads the clock.
- **Generation is deterministic.** The same as-of day gives byte-identical
  output. Values a real system would draw at random (ids, prescription
  numbers, times of day) are hashed from the names of what they belong to
  (`Seeded`, `StoryDay.instantOn`), and jitter never moves an event off the
  day its story sets.
- **Formats are their own packages'.** A generator builds `http-archive`
  values (through `HarCapture`) and FHIR shapes from `fhir-r4`; it declares no
  wire type another package already owns.
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
  schema every capture is built on.
- [Property Testing Reference](../../docs/Testing/Property%20Testing%20Reference.md)
  — property tests are the default here.
