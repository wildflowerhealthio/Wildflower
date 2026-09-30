/**
 * The LifeLabs synthetic data generator: a `synthetic-data-fundamentals/story`
 * `Story`'s lab draws as the reports a LifeLabs laboratory prints
 * (`LifeLabs.reportsOf`), and as the FHIR R4 resources the LifeLabs PDF import
 * makes of them, filed on the person's pharmacy Patient (`LifeLabs.render`).
 *
 * Deterministic: the same as-of day gives identical output.
 *
 * @packageDocumentation
 */
export type { LabRequisition } from './lab-requisition.ts'
export * as Laboratory from './laboratory.ts'
export * as LifeLabs from './lifelabs.ts'
