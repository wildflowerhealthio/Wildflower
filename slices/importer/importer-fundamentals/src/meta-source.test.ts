import { withMandatoryId } from '@wildflowerhealthio/fhir-r4/data-types'
import { type FhirResourceWithId, Patient } from '@wildflowerhealthio/fhir-r4/resources'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import * as MetaSource from './meta-source.ts'
import type * as Row from './row.ts'
import * as SectionedList from './sectioned-list.ts'

const fakeResource = (id: string): FhirResourceWithId =>
  Schema.decodeUnknownSync(withMandatoryId(Patient.Schema))({ resourceType: 'Patient', id })

interface Marker {
  readonly resourceType: 'Basic'
  readonly id: string
  readonly meta: {
    source: string | null
    lastUpdated: null
    profile: readonly string[]
    security: readonly never[]
    tag: readonly never[]
    versionId: string | null
  } | null
}

const marker = (id: string): Marker => ({ resourceType: 'Basic', id, meta: null })

describe('MetaSource.makeReference', () => {
  it('property: a reference is the id under the DocumentReference type', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (id) => {
        expect(MetaSource.makeReference(id)).toBe(`DocumentReference/${id}`)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('MetaSource.stamp', () => {
  it('should set meta.source and keep the rest of an existing meta', () => {
    const before: Marker = {
      ...marker('m'),
      meta: {
        lastUpdated: null,
        profile: ['p'],
        security: [],
        tag: [],
        versionId: '3',
        source: null,
      },
    }
    const after = MetaSource.stamp(before, 'DocumentReference/d')
    expect(after.meta?.source).toBe('DocumentReference/d')
    expect(after.meta?.profile).toEqual(['p'])
    expect(after.meta?.versionId).toBe('3')
  })
})

describe('MetaSource.stampDecoded', () => {
  it('property: stamping links every resource in every section and changes nothing else', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            title: fc.string(),
            rows: fc.array(
              fc.record({
                key: fc.string(),
                title: fc.string(),
                resource: fc.string().map(fakeResource),
                origin: fc.constant<Row.Origin>('Decoded'),
              })
            ),
          })
        ),
        fc.string({ minLength: 1 }).map(MetaSource.makeReference),
        (sections, source) => {
          const stamped = MetaSource.stampDecoded(
            { rows: SectionedList.make(sections), notes: [] },
            source
          )
          expect(stamped.rows.sections.map((section) => section.title)).toEqual(
            sections.map((section) => section.title)
          )
          for (const [index, section] of stamped.rows.sections.entries()) {
            expect(section.rows.map((row) => row.key)).toEqual(
              sections[index]?.rows.map((row) => row.key)
            )
            for (const row of section.rows) expect(row.resource.meta?.source).toBe(source)
          }
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
