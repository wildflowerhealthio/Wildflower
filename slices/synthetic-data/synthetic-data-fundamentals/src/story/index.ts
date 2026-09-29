/**
 * The story model: the base domain objects a data set's narrative is written
 * in and a renderer reads. A `Story` is one person's record — a `Person`, their
 * `Prescription`s of `DrugProduct`s, and the `LabDraw`s their dose changes
 * answer to — with every date a `StoryDay` relative to one as-of date, so the
 * same story renders on any as-of date without drifting.
 *
 * One namespace per module, in the `effect` style (`Prescription.statusOf`,
 * `StoryDay.instantOn`). The stories themselves — who the people are and what
 * they were prescribed — live in `wildflowerhealthio/synthetic-data`.
 *
 * @packageDocumentation
 */
export * as DrugProduct from './drug-product.ts'
export * as LabDraw from './lab-draw.ts'
export * as Person from './person.ts'
export * as Prescription from './prescription.ts'
export * as Story from './story.ts'
export * as StoryDay from './story-day.ts'
