import { Schema } from 'effect'
import * as fc from 'fast-check'
import { type FhirResource, Patient } from 'fhir-r4/resources'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import * as DecodedFile from './decoded-file.ts'

/** A minimal `FhirResource` — a `Patient` needs nothing but `resourceType` — keyed by `id`. */
const resource = (id: string): FhirResource =>
  Schema.decodeUnknownSync(Patient.Schema)({ resourceType: 'Patient', id })

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
