import { FhirResourceSchema } from '@wildflowerhealthio/fhir-r4/resources'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { DateTime, Effect, Either, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import * as Entry from './snapshot-entry.ts'
import * as Snapshot from './snapshot.ts'
import {
  fetcherOf,
  importRexallPerson,
  rexallPersonCaseArbitrary,
  type RexallPersonCase,
} from './test-helpers.ts'

/**
 * The write order: over a snapshot read back from real importer output, every
 * resource once and after every resource it references; and, over hand-made
 * resources, the order the references give, the cap, cycles, versioned
 * references and references that are not relative.
 */

const RUNS = numRunsFor({ base: 10 })

/** Each property imports every generated case: generous, so a slow runner fits. */
const IMPORT_TIMEOUT_MILLIS = 60_000

const AS_OF = DateTime.unsafeMake('2026-09-28T00:00:00.000Z')

const COMMIT = '0123456789abcdef0123456789abcdef01234567'

const labelOf = (resource: Entry.StoredResource): string =>
  `${resource.resourceType}/${resource.id}`

const decodeResource = Schema.decodeUnknownSync(FhirResourceSchema)

const decodeResourceEntry = Schema.decodeUnknownSync(Entry.ResourceSchema)

/** The resource `json` describes, as a snapshot stores it. */
const stored = (json: unknown): Entry.StoredResource =>
  decodeResourceEntry({ _tag: 'Resource', resource: decodeResource(json) }).resource

const patient = (id: string, linkedTo?: string): Entry.StoredResource =>
  stored({
    resourceType: 'Patient',
    id,
    ...(linkedTo === undefined
      ? {}
      : { link: [{ other: { reference: linkedTo }, type: 'seealso' }] }),
  })

const observation = (id: string, subject: string): Entry.StoredResource =>
  stored({
    resourceType: 'Observation',
    id,
    status: 'final',
    code: { text: 'Heart rate' },
    subject: { reference: subject },
  })

const serviceRequest = (id: string, subject: string): Entry.StoredResource =>
  stored({
    resourceType: 'ServiceRequest',
    id,
    status: 'completed',
    intent: 'order',
    subject: { reference: subject },
  })

const imagingStudy = (id: string, subject: string, basedOn: string): Entry.StoredResource =>
  stored({
    resourceType: 'ImagingStudy',
    id,
    status: 'available',
    subject: { reference: subject },
    basedOn: [{ reference: basedOn }],
  })

const sourceFile = (id: string, subject: string, related: string): Entry.StoredResource =>
  stored({
    resourceType: 'DocumentReference',
    id,
    status: 'current',
    subject: { reference: subject },
    context: { related: [{ reference: related }] },
    content: [{ attachment: { contentType: 'application/dicom', data: 'AA==' } }],
  })

const encodeResource = Schema.encodeSync(FhirResourceSchema)

/**
 * Each `from` resource among `resources` whose FHIR JSON holds a
 * `"reference": "<to>"` naming another of them: found in the encoded text,
 * not by `referencesOf`, so the property checks the order against the
 * references themselves.
 */
const referencesAmong = (
  resources: readonly Entry.StoredResource[]
): readonly { readonly from: string; readonly to: string }[] =>
  resources.flatMap((resource) => {
    const text = JSON.stringify(encodeResource(resource))
    return resources
      .map(labelOf)
      .filter(
        (to) => to !== labelOf(resource) && text.includes(`"reference":${JSON.stringify(to)}`)
      )
      .map((to) => ({ from: labelOf(resource), to }))
  })

const labelsOf = (
  bundles: readonly (readonly Entry.StoredResource[])[]
): readonly (readonly string[])[] => bundles.map((bundle) => bundle.map(labelOf))

/** Every resource of a snapshot of one imported Rexall person, read back as a reader reads it. */
const readBack = async (personCase: RexallPersonCase): Promise<readonly Entry.StoredResource[]> => {
  const { resources } = await importRexallPerson(personCase)
  const files = Either.getOrThrow(
    Either.flatMap(
      Snapshot.assemble(AS_OF, COMMIT, [
        { member: { key: 'rexall-person', displayName: 'Sam Okoye', summary: '' }, resources },
      ]),
      Snapshot.filesOf
    )
  )
  const fetcher = fetcherOf(files)
  return Effect.runPromise(
    Effect.gen(function* () {
      const header = yield* Snapshot.Reader.readHeader(fetcher)
      const paths = Snapshot.Header.pathsOf(header, new Set(['rexall-person'])).resources
      return yield* Effect.forEach(paths, (path) => Snapshot.Reader.readResource(fetcher, path))
    })
  )
}

describe('Snapshot.WriteOrder.bundlesOf', () => {
  test(
    'property: over a snapshot read back from real importer output, every resource once, each after every resource it references, no bundle over the cap',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          rexallPersonCaseArbitrary,
          fc.integer({ min: 1, max: 20 }),
          async (personCase, maxEntries) => {
            const resources = await readBack(personCase)

            const bundles = Snapshot.WriteOrder.bundlesOf(resources, maxEntries)

            expect(bundles.flat().map(labelOf).toSorted()).toEqual(
              resources.map(labelOf).toSorted()
            )
            for (const bundle of bundles) {
              expect(bundle.length).toBeGreaterThan(0)
              expect(bundle.length).toBeLessThanOrEqual(maxEntries)
            }
            const bundleIndexOf = new Map(
              bundles.flatMap((bundle, index) =>
                bundle.map((one) => [labelOf(one), index] as const)
              )
            )
            const references = referencesAmong(resources)
            // Every record references its Patient, and the image's source file its study.
            expect(references.length).toBeGreaterThan(0)
            expect(
              references.some(
                ({ from, to }) =>
                  from.startsWith('DocumentReference/') && to.startsWith('ImagingStudy/')
              )
            ).toBe(true)
            for (const { from, to } of references) {
              expect(bundleIndexOf.get(to)).toBeLessThan(bundleIndexOf.get(from) ?? -1)
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
    expect(labelsOf(Snapshot.WriteOrder.bundlesOf(resources))).toEqual([
      ['Patient/p'],
      ['ServiceRequest/order'],
      ['ImagingStudy/study'],
      ['DocumentReference/image-source'],
    ])
  })

  test('orders nothing by a reference to a resource it is not writing', () => {
    const resources = [observation('o-1', 'Patient/elsewhere'), patient('p')]
    expect(labelsOf(Snapshot.WriteOrder.bundlesOf(resources))).toEqual([
      ['Observation/o-1', 'Patient/p'],
    ])
  })

  test('splits a round into bundles of at most the cap, keeping the given order', () => {
    const resources = [
      patient('p'),
      ...['o-1', 'o-2', 'o-3', 'o-4', 'o-5'].map((id) => observation(id, 'Patient/p')),
    ]
    expect(labelsOf(Snapshot.WriteOrder.bundlesOf(resources, 2))).toEqual([
      ['Patient/p'],
      ['Observation/o-1', 'Observation/o-2'],
      ['Observation/o-3', 'Observation/o-4'],
      ['Observation/o-5'],
    ])
  })

  test('caps a bundle at MAX_BUNDLE_ENTRIES by default', () => {
    const resources = Array.from({ length: Snapshot.WriteOrder.MAX_BUNDLE_ENTRIES + 1 }, (_, i) =>
      patient(`p-${i}`)
    )
    expect(Snapshot.WriteOrder.bundlesOf(resources).map((bundle) => bundle.length)).toEqual([
      Snapshot.WriteOrder.MAX_BUNDLE_ENTRIES,
      1,
    ])
  })

  test('writes resources that reference each other in a cycle in one last round', () => {
    const resources = [
      patient('a', 'Patient/b'),
      patient('b', 'Patient/a'),
      observation('o', 'Patient/a'),
      patient('c'),
    ]
    expect(labelsOf(Snapshot.WriteOrder.bundlesOf(resources))).toEqual([
      ['Patient/c'],
      ['Patient/a', 'Patient/b', 'Observation/o'],
    ])
  })

  test('writes a resource that references one in a cycle after the whole cycle', () => {
    const resources = [
      observation('o', 'Patient/a'),
      patient('a', 'Patient/b'),
      patient('b', 'Patient/a'),
    ]
    expect(labelsOf(Snapshot.WriteOrder.bundlesOf(resources))).toEqual([
      ['Observation/o', 'Patient/a', 'Patient/b'],
    ])
  })

  test('writes after a resource that a versioned reference names', () => {
    const resources = [observation('o', 'Patient/p/_history/2'), patient('p')]
    expect(labelsOf(Snapshot.WriteOrder.bundlesOf(resources))).toEqual([
      ['Patient/p'],
      ['Observation/o'],
    ])
  })

  test('writes nothing for no resources', () => {
    expect(Snapshot.WriteOrder.bundlesOf([])).toEqual([])
  })

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'throws for the cap %d, not a whole number of at least one',
    (maxEntries) => {
      expect(() => Snapshot.WriteOrder.bundlesOf([patient('p')], maxEntries)).toThrow()
    }
  )
})

describe('Snapshot.WriteOrder.referencesOf', () => {
  test('names each relative reference once, and not the resource itself', () => {
    const resource = stored({
      resourceType: 'Observation',
      id: 'o',
      status: 'final',
      code: { text: 'Heart rate' },
      subject: { reference: 'Patient/p' },
      performer: [{ reference: 'Patient/p' }, { reference: 'Practitioner/dr' }],
      hasMember: [{ reference: 'Observation/o' }],
    })
    expect([...Snapshot.WriteOrder.referencesOf(resource)].toSorted()).toEqual([
      'Patient/p',
      'Practitioner/dr',
    ])
  })

  test('names a versioned reference’s resource, without its version', () => {
    expect([...Snapshot.WriteOrder.referencesOf(observation('o', 'Patient/p/_history/2'))]).toEqual(
      ['Patient/p']
    )
  })

  test.each([
    '#contained',
    'urn:uuid:0f7c',
    'https://fhir.example/Patient/p',
    'Patient/p/_history/',
    'patient/p',
    'Patient/',
    `Patient/${'x'.repeat(65)}`,
  ])('names nothing for the reference %j', (reference) => {
    expect([...Snapshot.WriteOrder.referencesOf(observation('o', reference))]).toEqual([])
  })
})
