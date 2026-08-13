import { Schema } from 'effect'
import * as fc from 'fast-check'
import type { ResourceWriteFailure } from 'fhir-r4/clients'
import { type FhirResource, Patient } from 'fhir-r4/resources'
import type { Preview } from 'importer-core'
import { describe, expect, it, test } from 'vite-plus/test'

import { importOutcome, isPartialOutcome, previewResourceCount } from './import-outcome.ts'

/**
 * The pure fold from a written preview + its failures to the results tally. The
 * one property that matters is the `collectImportSummary` semantics: **any**
 * failure makes the whole import partial, `written` is exactly the attempted
 * count minus the failures, and the failure list is carried verbatim — never a
 * fraction, a threshold, or a re-count off the wire.
 */

describe('importOutcome', () => {
  test('property: written = attempted − failures, and any failure ⇒ partial', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 30 }),
        fc.nat({ max: 30 }),
        fc.string({ minLength: 1 }),
        (resourceCount, failureCount, sourceRef) => {
          const preview = previewWith(resourceCount)
          const failures = failuresOf(failureCount)
          const outcome = importOutcome(preview, sourceRef, failures)

          expect(outcome.attempted).toBe(resourceCount)
          expect(outcome.written).toBe(resourceCount - failureCount)
          expect(outcome.failures).toBe(failures)
          expect(outcome.sourceRef).toBe(sourceRef)
          expect(isPartialOutcome(outcome)).toBe(failureCount > 0)
        }
      ),
      { numRuns: 200 }
    )
  })

  it('counts resources across every type', () => {
    const preview = previewOf({
      Patient: [patient('a'), patient('b')],
      Observation: [patient('c')],
    })
    expect(previewResourceCount(preview)).toBe(3)
  })

  it('is complete with an empty failure list, partial with any failure', () => {
    const preview = previewWith(2)
    expect(isPartialOutcome(importOutcome(preview, 'DocumentReference/a', []))).toBe(false)
    expect(isPartialOutcome(importOutcome(preview, 'DocumentReference/a', failuresOf(1)))).toBe(
      true
    )
  })
})

// Helpers

/** A schema-valid `Patient` with a known id; only its count and identity matter here. */
const patient = (id: string): FhirResource =>
  Schema.decodeUnknownSync(Patient.Schema)({ resourceType: 'Patient', id })

/** A `Preview` holding exactly `count` resources, all Patients. */
const previewWith = (count: number): Preview =>
  previewOf({ Patient: Array.from({ length: count }, (_, index) => patient(`pat-${index}`)) })

/** A `Preview` carrying the given resources, grouped by type; other fields empty. */
const previewOf = (
  resourcesByType: Readonly<Record<string, readonly FhirResource[]>>
): Preview => ({
  _tag: 'Preview',
  collectorTag: 'fhir-r4',
  rootUrls: ['https://r4.example.org/baseR4'],
  resourcesByType,
  parseFailures: [],
  unmatchedCount: 0,
  bodyAbsentCount: 0,
  totalEntries: Object.values(resourcesByType).flat().length,
})

/** `count` distinct write failures, shaped like the write sink's own records. */
const failuresOf = (count: number): readonly ResourceWriteFailure[] =>
  Array.from({ length: count }, (_, index) => ({
    failed: { label: 'Observation', id: `obs-${index}` },
    cause: `write ${index} rejected`,
  }))
