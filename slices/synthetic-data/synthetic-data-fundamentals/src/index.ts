/**
 * The base every synthetic data generator builds on: the story model (people,
 * prescriptions, lab draws, every date a `StoryDay`), deterministic seeded
 * values, and the synthetic defaults of a generated browser capture — exposed
 * as one namespace per module in the `effect` style (`Prescription.statusOf`,
 * `StoryDay.instantOn`, `HarCapture.entryOf`).
 *
 * Every date is a `StoryDay` relative to an as-of date the caller passes, and
 * every id or time a real system would draw at random is hashed from the names
 * of what it belongs to (`Seeded`), so a generator built on this is
 * deterministic: the same as-of date gives byte-identical output.
 *
 * The stories themselves — who the people are and what they were prescribed —
 * live in `wildflowerhealthio/synthetic-data`.
 *
 * @packageDocumentation
 */
export * as DrugProduct from './drug-product.ts'
export * as HarCapture from './har-capture.ts'
export * as LabDraw from './lab-draw.ts'
export * as Person from './person.ts'
export * as Prescription from './prescription.ts'
export * as Seeded from './seeded.ts'
export * as Story from './story.ts'
export * as StoryDay from './story-day.ts'
