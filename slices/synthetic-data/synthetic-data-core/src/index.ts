/**
 * The synthetic data set's pure tooling: the story model (people,
 * prescriptions, lab draws, every date a `StoryDay`), and one renderer per
 * source that turns a story into the bytes that source would produce —
 * exposed as one namespace per module in the `effect` style
 * (`Prescription.statusOf`, `RexallHar.render`).
 *
 * Every date is a `StoryDay` relative to an as-of date the caller passes, and
 * every id or time a real system would draw at random is hashed from the names
 * of what it belongs to (`Seeded`), so a render is deterministic: the same
 * as-of date gives byte-identical output.
 *
 * The published data set's shape lives here too, shared by the step that
 * emits it and the app that loads it: where each resource and source file sits
 * (`DataSetLayout`), the `index.json` manifest schema (`DataSetManifest`), and
 * every file to write (`DataSet.assemble`).
 *
 * The stories themselves — who the people are and what they were prescribed —
 * live in `wildflowerhealthio/synthetic-data`, which renders them with this
 * package.
 *
 * @packageDocumentation
 */
export * as ChromeHar from './har/chrome-har.ts'
export * as DataSet from './data-set/data-set.ts'
export * as DataSetLayout from './data-set/data-set-layout.ts'
export * as DataSetManifest from './data-set/data-set-manifest.ts'
export * as DicomImage from './dicom/dicom-image.ts'
export * as DrugProduct from './drug-product.ts'
export * as LifeLabs from './lifelabs/lifelabs.ts'
export * as LifeLabsLaboratory from './lifelabs/laboratory.ts'
export * as PebbleObservations from './pebble/pebble-observations.ts'
export * as PebbleWatch from './pebble/pebble-watch.ts'
export * as Person from './person.ts'
export * as Prescription from './prescription.ts'
export * as RexallHar from './rexall/rexall-har.ts'
export * as Seeded from './seeded.ts'
export * as ShoppersHar from './shoppers/shoppers-har.ts'
export * as SourcePatient from './source-patient.ts'
export * as StoryDay from './story-day.ts'
export * as LabDraw from './lab-draw.ts'
export * as Story from './story.ts'
