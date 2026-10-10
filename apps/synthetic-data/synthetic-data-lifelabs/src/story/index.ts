/**
 * The LifeLabs story objects: what a data set writes, beside a
 * `synthetic-data-fundamentals/story` `Story`, for its lab draws to be printed
 * by LifeLabs — the `Laboratory` the specimens go to (how it prints each test,
 * with each test's `PrintedRange`) and the `LabRequisition` naming who orders
 * the person's lab work. `LifeLabs.render` reads them alongside the story.
 *
 * One namespace per module, in the `effect` style (`PrintedRange.flagOf`,
 * `Laboratory.testOf`). A catalogue of real tests is data, and lives with the
 * stories in `wildflowerhealthio/synthetic-data`.
 *
 * @packageDocumentation
 */
export * as LabRequisition from './lab-requisition.ts'
export * as Laboratory from './laboratory.ts'
export * as PrintedRange from './printed-range.ts'
