/**
 * The FHIR Sync for Pebble synthetic data generator: a `Physiology` — what a
 * wrist-worn watch measures, day by day — as the Observations the FHIR Sync
 * for Pebble phone app writes when the watch syncs it
 * (`PebbleObservations.render`), recorded by a deterministic synthetic watch
 * (`PebbleWatch.watchOf`).
 *
 * Deterministic: the same as-of day gives identical output.
 *
 * @packageDocumentation
 */
export * as PebbleObservations from './pebble-observations.ts'
export * as PebbleWatch from './pebble-watch.ts'
export type { Circadian, Night, Physiology, PhysiologyDay, Span, Walk } from './physiology.ts'
