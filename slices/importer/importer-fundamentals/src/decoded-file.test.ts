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
