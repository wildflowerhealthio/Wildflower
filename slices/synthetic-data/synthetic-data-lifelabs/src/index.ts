/**
 * The LifeLabs synthetic data generator: a `synthetic-data-fundamentals/story`
 * `Story`'s lab draws as the reports a LifeLabs laboratory prints
 * (`LifeLabs.reportsOf`), and as the FHIR R4 resources the LifeLabs PDF import
 * makes of them, filed on the person's pharmacy Patient (`LifeLabs.render`).
 * The laboratory and requisition it reads are `synthetic-data-lifelabs/story`'s.
 *
 * Deterministic: the same as-of day gives identical output.
 *
 * @packageDocumentation
 */
export * as LifeLabs from './lifelabs.ts'
