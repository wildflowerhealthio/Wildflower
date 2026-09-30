import { Schema } from 'effect'
import * as fc from 'fast-check'
import { type FhirResource, FhirResourceSchema } from 'fhir-r4/resources'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { importRexallPerson, rexallPersonCaseArbitrary } from './test-helpers.ts'
import * as WriteOrder from './write-order.ts'

const RUNS = numRunsFor({ base: 10 })

/** Each property imports every generated case: generous, so a slow runner fits. */
const IMPORT_TIMEOUT_MILLIS = 60_000

const labelOf = (resource: FhirResource): string => `${resource.resourceType}/${resource.id}`

const decodeResource = Schema.decodeUnknownSync(FhirResourceSchema)

const patient = (id: string, linkedTo?: string): FhirResource =>
  decodeResource({
    resourceType: 'Patient',
    id,
    ...(linkedTo === undefined
      ? {}
      : { link: [{ other: { reference: linkedTo }, type: 'seealso' }] }),
  })

const observation = (id: string, subject: string): FhirResource =>
  decodeResource({
    resourceType: 'Observation',
    id,
    status: 'final',
    code: { text: 'Heart rate' },
    subject: { reference: subject },
  })

const serviceRequest = (id: string, subject: string): FhirResource =>
  decodeResource({
    resourceType: 'ServiceRequest',
    id,
    status: 'completed',
    intent: 'order',
    subject: { reference: subject },
  })

const imagingStudy = (id: string, subject: string, basedOn: string): FhirResource =>
  decodeResource({
    resourceType: 'ImagingStudy',
    id,
    status: 'available',
    subject: { reference: subject },
    basedOn: [{ reference: basedOn }],
  })

const sourceFile = (id: string, subject: string, related: string): FhirResource =>
  decodeResource({
    resourceType: 'DocumentReference',
    id,
    status: 'current',
    subject: { reference: subject },
    context: { related: [{ reference: related }] },
    content: [{ attachment: { contentType: 'application/dicom', data: 'AA==' } }],
  })

const labelsOf = (bundles: readonly (readonly FhirResource[])[]): readonly (readonly string[])[] =>
  bundles.map((bundle) => bundle.map(labelOf))

describe('WriteOrder.bundlesOf', () => {
  test(
    'property: over real importer output, every resource once, each after every resource it references, no bundle over the cap',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          rexallPersonCaseArbitrary,
          fc.integer({ min: 1, max: 20 }),
          async (personCase, maxEntries) => {
            const { resources } = await importRexallPerson(personCase)
            const unique = [...new Map(resources.map((one) => [labelOf(one), one])).values()]

            const bundles = WriteOrder.bundlesOf(unique, maxEntries)

            expect(bundles.flat().map(labelOf).toSorted()).toEqual(unique.map(labelOf).toSorted())
            for (const bundle of bundles) {
              expect(bundle.length).toBeGreaterThan(0)
              expect(bundle.length).toBeLessThanOrEqual(maxEntries)
            }
            const present = new Set(unique.map(labelOf))
            const bundleIndexOf = new Map(
              bundles.flatMap((bundle, index) =>
                bundle.map((one) => [labelOf(one), index] as const)
              )
            )
            for (const resource of unique) {
              for (const reference of WriteOrder.referencesOf(resource)) {
                if (!present.has(reference)) continue
                expect(bundleIndexOf.get(reference)).toBeLessThan(
                  bundleIndexOf.get(labelOf(resource)) ?? -1
                )
              }
            }
          }
        ),
        { numRuns: RUNS }
      )
    },
    IMPORT_TIMEOUT_MILLIS
  )

  test('writes an image’s source file after the study read from it, and the study after its order', () => {
    const resources = [
      sourceFile('image-source', 'Patient/p', 'ImagingStudy/study'),
      imagingStudy('study', 'Patient/p', 'ServiceRequest/order'),
      serviceRequest('order', 'Patient/p'),
      patient('p'),
    ]
    expect(labelsOf(WriteOrder.bundlesOf(resources))).toEqual([
      ['Patient/p'],
      ['ServiceRequest/order'],
      ['ImagingStudy/study'],
      ['DocumentReference/image-source'],
    ])
  })

  test('orders nothing by a reference to a resource it is not writing', () => {
    const resources = [observation('o-1', 'Patient/elsewhere'), patient('p')]
    expect(labelsOf(WriteOrder.bundlesOf(resources))).toEqual([['Observation/o-1', 'Patient/p']])
  })

  test('splits a round into bundles of at most the cap, keeping the given order', () => {
    const resources = [
      patient('p'),
      ...['o-1', 'o-2', 'o-3', 'o-4', 'o-5'].map((id) => observation(id, 'Patient/p')),
    ]
    expect(labelsOf(WriteOrder.bundlesOf(resources, 2))).toEqual([
      ['Patient/p'],
      ['Observation/o-1', 'Observation/o-2'],
      ['Observation/o-3', 'Observation/o-4'],
      ['Observation/o-5'],
    ])
  })

  test('writes resources that reference each other in a cycle in one last round', () => {
    const resources = [
      patient('a', 'Patient/b'),
      patient('b', 'Patient/a'),
      observation('o', 'Patient/a'),
      patient('c'),
    ]
    expect(labelsOf(WriteOrder.bundlesOf(resources))).toEqual([
      ['Patient/c'],
      ['Patient/a', 'Patient/b', 'Observation/o'],
    ])
  })

  test('writes nothing for no resources', () => {
    expect(WriteOrder.bundlesOf([])).toEqual([])
  })
})

describe('WriteOrder.referencesOf', () => {
  test('names each relative reference once, and not the resource itself', () => {
    const resource = decodeResource({
      resourceType: 'Observation',
      id: 'o',
      status: 'final',
      code: { text: 'Heart rate' },
      subject: { reference: 'Patient/p' },
      performer: [{ reference: 'Patient/p' }, { reference: 'Practitioner/dr' }],
      hasMember: [{ reference: 'Observation/o' }],
    })
    expect([...WriteOrder.referencesOf(resource)].toSorted()).toEqual([
      'Patient/p',
      'Practitioner/dr',
    ])
  })

  test.each([
    '#contained',
    'urn:uuid:0f7c',
    'https://fhir.example/Patient/p',
    'Patient/p/_history/2',
  ])('names nothing for the reference %j', (reference) => {
    expect([...WriteOrder.referencesOf(observation('o', reference))]).toEqual([])
  })
})
