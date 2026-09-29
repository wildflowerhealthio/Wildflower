# AGENTS.md — slices/synthetic-data

The **synthetic data set**: one fictional family across three generations —
the Ashfords — whose records tell stories where a dose change moves a lab
level or a device reading, rendered as the files each real source would
produce and read back through Wildflower's own importers, so the data looks
exactly like an import would. Epic #787.

## Packages

- **[`synthetic-data-core`](./synthetic-data-core/AGENTS.md)** (pure) — the
  family's demographics and dated stories (prescriptions, fills, lab draws),
  and one renderer per source: the Rexall Be Well HAR today.

## The family

| Person                 | Name cue                  | Story                                                                                        | Sources                    |
| ---------------------- | ------------------------- | -------------------------------------------------------------------------------------------- | -------------------------- |
| **Warren Ashford**, 78 | **War**ren → **war**farin | Atrial fibrillation on warfarin (5 → 4 mg, held for clarithromycin); metformin 500 → 1000 mg | Rexall HAR, labs, DICOM    |
| **Tyra Ashford**, 46   | **Ty**ra → **thy**roid    | Hypothyroidism with an overshoot on levothyroxine                                            | Shoppers HAR, labs, Pebble |
| **Beau Hartman**, 48   | **Beau** → beta blocker   | Hypertension and high LDL: atorvastatin, bisoprolol                                          | Shoppers HAR, labs         |
| **Fern Ashford**, 16   | **Fe**rn → Fe, iron       | Iron-deficiency anemia on ferrous sulfate                                                    | Shoppers HAR, labs         |

Only Warren's story and his Rexall HAR are built so far; the others have their
demographics.

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
  fixtures, spelled from its constants), and a round-trip test runs it through
  the real importer and asserts the story comes out.
- **DINs are real.** Every drug product is a marketed Canadian product whose
  DIN, strength and form were verified against Health Canada's Drug Product
  Database; see `DrugProduct.catalogue`.
