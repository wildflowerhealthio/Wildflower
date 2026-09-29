/**
 * The synthetic data set's pure core: the Ashford family's demographics and
 * dated stories, and one renderer per source that turns a story into the
 * bytes that source would produce — exposed as one namespace per module in the
 * `effect` style (`Prescription.statusOf`, `RexallHar.render`).
 *
 * Every date is a `StoryDay` relative to an as-of date the caller passes, and
 * every id or time a real system would draw at random is hashed from the names
 * of what it belongs to (`Seeded`), so a render is deterministic: the same
 * as-of date gives byte-identical output.
 *
 * @packageDocumentation
 */
export * as Ashford from './ashford/index.ts'
export * as ChromeHar from './har/chrome-har.ts'
export * as DrugProduct from './drug-product.ts'
export * as Person from './person.ts'
export * as Prescription from './prescription.ts'
export * as RexallHar from './rexall/rexall-har.ts'
export * as Seeded from './seeded.ts'
export * as StoryDay from './story-day.ts'
export * as LabDraw from './lab-draw.ts'
export * as Story from './story.ts'
