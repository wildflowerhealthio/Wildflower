import { withMandatoryId } from '@wildflowerhealthio/fhir-r4/data-types'
import { type FhirResourceWithId, Patient } from '@wildflowerhealthio/fhir-r4/resources'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import * as DecodedFile from './decoded-file.ts'

/** A minimal `FhirResource` — a `Patient` needs nothing but `resourceType` — keyed by `id`. */
const resource = (id: string): FhirResourceWithId =>
  Schema.decodeUnknownSync(withMandatoryId(Patient.Schema))({ resourceType: 'Patient', id })

describe('sectionResources', () => {
  it('should flatten a decoded file’s sections into one list, in section order', () => {
    const sections: readonly DecodedFile.Section[] = [
      {
        title: 'https://r4.example.org/Patient/pat-7',
        resources: [{ key: 'req-0:0', title: 'Patient/pat-7', resource: resource('pat-7') }],
      },
      {
        title: 'https://r4.example.org/Observation?patient=pat-7',
        resources: [
          { key: 'req-1:0', title: 'Observation/obs-1', resource: resource('weight') },
          { key: 'req-1:1', title: 'Observation/obs-2', resource: resource('height') },
        ],
      },
    ]

    expect(DecodedFile.resources({ sections }).map((entry) => entry.key)).toEqual([
      'req-0:0',
      'req-1:0',
      'req-1:1',
    ])
  })

  it('property: flattening preserves every resource exactly once, in order', () => {
    const sectionArbitrary = fc.record({
      title: fc.string(),
      resources: fc.array(
        fc.record({ key: fc.string(), title: fc.string(), resource: fc.string().map(resource) })
      ),
    })
    fc.assert(
      fc.property(fc.array(sectionArbitrary), (sections) => {
        const flat = DecodedFile.resources({ sections })

        expect(flat).toEqual(sections.flatMap((section) => section.resources))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('mapResources', () => {
  const file: DecodedFile.DecodedFile = {
    sections: [
      { title: 'First', resources: [{ key: 'k-0', title: 'Patient/a', resource: resource('a') }] },
      {
        title: 'Second',
        resources: [
          { key: 'k-1', title: 'Patient/b', resource: resource('b') },
          { key: 'k-2', title: 'Patient/c', resource: resource('c') },
        ],
      },
    ],
    notes: ['a note'],
  }

  it('gives back the file itself when every entry comes back as itself', () => {
    expect(DecodedFile.mapResources(file, (entry) => entry)).toBe(file)
  })

  it('replaces only the entries that changed, keeping every untouched entry and section as itself', () => {
    const retitled = DecodedFile.mapResources(file, (entry) =>
      entry.key === 'k-2' ? { ...entry, title: 'Patient C' } : entry
    )

    expect(retitled).not.toBe(file)
    expect(retitled.notes).toBe(file.notes)
    expect(retitled.sections[0]).toBe(file.sections[0])
    expect(retitled.sections[1]?.resources[0]).toBe(file.sections[1]?.resources[0])
    expect(retitled.sections[1]?.resources[1]).toEqual({
      key: 'k-2',
      title: 'Patient C',
      resource: file.sections[1]?.resources[1]?.resource,
    })
  })
})

/** A Patient of id `id` whose one given name says which copy it is. */
const namedCopy = (id: string, given: string): FhirResourceWithId =>
  Schema.decodeUnknownSync(withMandatoryId(Patient.Schema))({
    resourceType: 'Patient',
    id,
    name: [{ given: [given] }],
  })

/** The given names of `resource`, a Patient, in order. */
const givenNamesOf = (patient: FhirResourceWithId): readonly string[] =>
  patient.resourceType === 'Patient' ? patient.name.flatMap((name) => name.given) : []

/** Joins two copies' names, earlier first, so a result shows which copies merged and in what order. */
const joinNames: DecodedFile.Merge = (earlier, later) =>
  earlier.resourceType === 'Patient' && later.resourceType === 'Patient'
    ? { ...later, name: [...earlier.name, ...later.name] }
    : later

/** A row keyed `key`, one copy named `given` of the shared Patient `id`. */
const sharedCopy = (key: string, id: string, given: string): DecodedFile.Resource => ({
  key,
  title: `Patient/${id}`,
  resource: namedCopy(id, given),
  shared: { identity: `Patient ${id}`, merge: joinNames },
})

/** Each row as its key and the given names it holds. */
const namesByKey = (
  rows: readonly DecodedFile.Resource[]
): readonly (readonly [string, readonly string[]])[] =>
  rows.map((row) => [row.key, givenNamesOf(row.resource)] as const)

describe('mergeSharedCopies', () => {
  it("should merge an identity's copies in order, in the first copy's place, the rest left out", () => {
    const rows = [
      sharedCopy('status:0', 'p', 'status'),
      { key: 'other:0', title: 'Patient/q', resource: namedCopy('q', 'other') },
      sharedCopy('history:0', 'p', 'history'),
    ]

    expect(namesByKey(DecodedFile.mergeSharedCopies(rows))).toEqual([
      ['status:0', ['status', 'history']],
      ['other:0', ['other']],
    ])
  })

  it("should keep a copy whose identity's other copies are not among the rows as it is", () => {
    const history = sharedCopy('history:0', 'p', 'history')

    expect(DecodedFile.mergeSharedCopies([history])).toEqual([history])
  })

  it('should merge each identity apart from the others', () => {
    const rows = [
      sharedCopy('a:0', 'p', 'p-first'),
      sharedCopy('a:1', 'q', 'q-first'),
      sharedCopy('b:0', 'q', 'q-second'),
      sharedCopy('b:1', 'p', 'p-second'),
    ]

    expect(namesByKey(DecodedFile.mergeSharedCopies(rows))).toEqual([
      ['a:0', ['p-first', 'p-second']],
      ['a:1', ['q-first', 'q-second']],
    ])
  })

  it('property: rows that are no shared copies come back exactly as they were', () => {
    const rowArbitrary = fc.record({
      key: fc.string(),
      title: fc.string(),
      resource: fc.string().map(resource),
    })
    fc.assert(
      fc.property(fc.array(rowArbitrary), (rows) => {
        expect(DecodedFile.mergeSharedCopies(rows)).toEqual(rows)
        expect(DecodedFile.withSharedCopiesMerged(rows)).toEqual(rows)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('withSharedCopiesMerged', () => {
  it('should give every copy of an identity the merge of its copies, keeping a row per copy', () => {
    const rows = [sharedCopy('status:0', 'p', 'status'), sharedCopy('history:0', 'p', 'history')]

    expect(namesByKey(DecodedFile.withSharedCopiesMerged(rows))).toEqual([
      ['status:0', ['status', 'history']],
      ['history:0', ['status', 'history']],
    ])
  })

  it('should keep the one copy of an identity among the rows as the same object', () => {
    const history = sharedCopy('history:0', 'p', 'history')

    expect(DecodedFile.withSharedCopiesMerged([history])[0]).toBe(history)
  })
})
