import { DateTime, Schema } from 'effect'
import * as fc from 'fast-check'
import { type FhirResource, FhirResourceSchema } from 'fhir-r4/resources'
import { numRunsFor } from 'kitchen-sink/test'
import type { DataSetManifest } from 'synthetic-data-core'
import { describe, expect, it } from 'vite-plus/test'

import {
  resourcePathsOf,
  resourceTypeCountsOf,
  WRITE_BATCH_SIZE,
  WRITE_ORDER,
  writeBatchesOf,
} from './load-plan.ts'

const RUNS = numRunsFor({ base: 50 })

/** The least JSON each resource type the generator draws decodes from. */
const MINIMAL_JSON: Readonly<Record<string, Record<string, unknown>>> = {
  Patient: {},
  Practitioner: {},
  DocumentReference: { status: 'current', content: [{ attachment: {} }] },
  MedicationRequest: {
    status: 'active',
    intent: 'order',
    medicationCodeableConcept: { text: 'x' },
    subject: { reference: 'Patient/p' },
  },
  Observation: { status: 'final', code: { text: 'x' } },
  DiagnosticReport: { status: 'final', code: { text: 'x' } },
  // Not in the write order: written last.
  Binary: { contentType: 'text/plain' },
}

const resourceArbitrary: fc.Arbitrary<FhirResource> = fc
  .record({
    resourceType: fc.constantFrom(...Object.keys(MINIMAL_JSON)),
    id: fc.stringMatching(/^[a-z0-9]{1,8}$/),
  })
  .map(({ resourceType, id }) =>
    Schema.decodeUnknownSync(FhirResourceSchema)({
      resourceType,
      id,
      ...MINIMAL_JSON[resourceType],
    })
  )

const rankOf = (resource: FhirResource): number => {
  const rank = WRITE_ORDER.indexOf(resource.resourceType)
  return rank === -1 ? WRITE_ORDER.length : rank
}

describe('writeBatchesOf', () => {
  it('property: writes every resource once, in type order, one type to a bundle, each full but a type’s last', () => {
    fc.assert(
      fc.property(fc.array(resourceArbitrary, { maxLength: 3 * WRITE_BATCH_SIZE }), (resources) => {
        const batches = writeBatchesOf(resources)
        const written = batches.flat()

        expect(written.toSorted(byLabel)).toEqual(resources.toSorted(byLabel))
        expect(written.map(rankOf)).toEqual(written.map(rankOf).toSorted((a, b) => a - b))
        // Within a type, the read order is kept.
        for (const resourceType of new Set(resources.map((one) => one.resourceType))) {
          const ofType = (list: readonly FhirResource[]): readonly FhirResource[] =>
            list.filter((one) => one.resourceType === resourceType)
          expect(ofType(written)).toEqual(ofType(resources))
        }
        expect(batches.every((batch) => batch.length > 0)).toBe(true)
        // A bundle's entries may be applied in any order, so none mixes types…
        for (const batch of batches) {
          expect(new Set(batch.map((one) => one.resourceType)).size).toBe(1)
        }
        // …and only a type's last bundle is short.
        batches.forEach((batch, index) => {
          const next = batches[index + 1]
          if (next !== undefined && next[0]?.resourceType === batch[0]?.resourceType) {
            expect(batch).toHaveLength(WRITE_BATCH_SIZE)
          }
        })
        // Each type's resources are adjacent, so a type is written before the next begins.
        const bundleTypes = batches.map((batch) => batch[0]?.resourceType)
        const typeRuns = bundleTypes.filter((type, index) => type !== bundleTypes[index - 1])
        expect(new Set(typeRuns).size).toBe(typeRuns.length)
      }),
      { numRuns: RUNS }
    )
  })

  it('should split a type past the bundle size, after the types it references', () => {
    const observations = Array.from({ length: 2 * WRITE_BATCH_SIZE + 50 }, (_, index) =>
      Schema.decodeUnknownSync(FhirResourceSchema)({
        resourceType: 'Observation',
        id: `obs-${index}`,
        ...MINIMAL_JSON['Observation'],
      })
    )
    const patient = Schema.decodeUnknownSync(FhirResourceSchema)({
      resourceType: 'Patient',
      id: 'p',
    })

    const batches = writeBatchesOf([...observations, patient])

    expect(batches.map((batch) => [batch[0]?.resourceType, batch.length])).toEqual([
      ['Patient', 1],
      ['Observation', WRITE_BATCH_SIZE],
      ['Observation', WRITE_BATCH_SIZE],
      ['Observation', 50],
    ])
  })
})

const byLabel = (left: FhirResource, right: FhirResource): number =>
  `${left.resourceType}/${left.id}`.localeCompare(`${right.resourceType}/${right.id}`)

const manifestWith = (
  people: readonly { readonly key: string; readonly resources: readonly string[] }[]
): DataSetManifest.Type => ({
  schemaVersion: 1,
  asOf: DateTime.unsafeMake('2026-09-28T00:00:00.000Z'),
  generator: { name: 'synthetic-data-core', wildflowerCommit: 'abc' },
  people: people.map(({ key, resources }) => ({
    key,
    displayName: key,
    summary: '',
    patientIds: [],
    resources,
    staticFiles: [],
  })),
  totals: { people: people.length, resources: 0, staticFiles: 0 },
})

describe('resourcePathsOf', () => {
  const manifest = manifestWith([
    {
      key: 'a',
      resources: ['fhir/DocumentReference/har.json', 'fhir/Patient/a.json'],
    },
    {
      key: 'b',
      resources: ['fhir/DocumentReference/har.json', 'fhir/Patient/b.json'],
    },
    { key: 'c', resources: ['fhir/Patient/c.json'] },
  ])

  it('should list the picked people’s files once each, in path order', () => {
    expect(resourcePathsOf(manifest, new Set(['b', 'a']))).toEqual([
      'fhir/DocumentReference/har.json',
      'fhir/Patient/a.json',
      'fhir/Patient/b.json',
    ])
  })

  it('should list nothing when no one is picked', () => {
    expect(resourcePathsOf(manifest, new Set())).toEqual([])
  })
})

describe('resourceTypeCountsOf', () => {
  it('should count each type, most first and ties by type', () => {
    expect(
      resourceTypeCountsOf([
        'fhir/Observation/1.json',
        'fhir/Patient/p.json',
        'fhir/Observation/2.json',
        'fhir/DocumentReference/d.json',
      ])
    ).toEqual([
      { resourceType: 'Observation', count: 2 },
      { resourceType: 'DocumentReference', count: 1 },
      { resourceType: 'Patient', count: 1 },
    ])
  })
})
