# AGENTS.md — slices/synthetic-data

The **synthetic data tooling**: a model for dated health stories — people,
prescriptions and their fills, lab draws — and renderers that turn a story
into the files each real source would produce, proven by reading them back
through Wildflower's own importers, so rendered data looks exactly like an
import would. Epic #787.

This slice holds **tooling only**. The stories themselves — the fictional
people, their narratives, the accounts they are filled under and the chosen,
DPD-verified drug products — live in the data repo,
[`wildflowerhealthio/synthetic-data`](https://github.com/wildflowerhealthio/synthetic-data),
which renders them with this package and publishes the output. Nothing here
names a person or tells a particular story.

## Packages

- **[`synthetic-data-core`](./synthetic-data-core/AGENTS.md)** (pure) — the
  story model (`Story`, `Person`, `Prescription`, `DrugProduct`, `LabDraw`,
  `StoryDay`), deterministic seeded values (`Seeded`), the HAR envelope
  (`ChromeHar`), and one renderer per source: the Rexall Be Well HAR, the
  Shoppers Drug Mart family-account HAR, LifeLabs lab results, the
  Observations FHIR Sync for Pebble writes for a day-by-day physiology, and a
  real, de-identified DICOM image re-identified for a story (`DicomImage`) and
  read back through the DICOM importer.

## Rules

- **Every date is relative to an as-of date.** Stories are written in
  `StoryDay`s (days from the as-of day) and turned into calendar dates only
  when rendered, so a regenerated data set tells the same story on new dates.
  Nothing reads the clock.
- **Rendering is deterministic.** The same as-of day gives byte-identical
  output. Values a real system would draw at random (ids, prescription
  numbers, times of day) are hashed from the names of what they belong to, and
  jitter never moves an event off the day its story sets.
- **Render what the source sends, then import it.** A renderer writes the
  source's own wire shape (modelled on that source package's anonymized
  fixtures, spelled from its constants), and a round-trip test runs generated
  stories through the real importer and asserts each one comes out as its
  generated inputs say.
- **One Patient record per person, except a Shoppers account holder.** The
  Shoppers importer always adds an account Patient keyed by `pcid` beside the
  one per managed person, so the holder has two records. A source with no
  Patient of its own to offer (the lab results) drops the one its importer
  makes and files its results on the person's pharmacy Patient
  (`SourcePatient`).
- **No narrative here.** Tests generate their stories (fast-check); a
  hand-written example inside a test is fine, a named person or a chosen
  product catalogue is not — those belong in the data repo.
