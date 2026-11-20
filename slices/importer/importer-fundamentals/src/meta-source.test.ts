import { withMandatoryId } from '@wildflowerhealthio/fhir-r4/data-types'
import { type FhirResourceWithId, Patient } from '@wildflowerhealthio/fhir-r4/resources'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Option, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import * as MetaSource from './meta-source.ts'
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

describe('MetaSource.stampAdopted', () => {
  it('property: stamping links every resource in every section and changes nothing else', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            title: fc.string(),
            rows: fc.array(
              fc.record({
                reviewKey: fc.string(),
                title: fc.string(),
                isImplied: fc.constant(false),
                resource: fc.string().map(fakeResource),
              })
            ),
          })
        ),
        fc.string({ minLength: 1 }).map(MetaSource.makeReference),
        (sections, source) => {
          const stamped = MetaSource.stampAdopted(
            { sectionedList: SectionedList.make(sections), notes: [] },
            source
          )
          expect(stamped.sectionedList.sections.map((section) => section.title)).toEqual(
            sections.map((section) => section.title)
          )
          for (const [index, section] of stamped.sectionedList.sections.entries()) {
            expect(section.rows.map((row) => row.reviewKey)).toEqual(
              sections[index]?.rows.map((row) => row.reviewKey)
            )
            for (const row of section.rows) expect(row.resource.meta?.source).toBe(source)
          }
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('MetaSource.sourceOf', () => {
  it('property: reads back the source file a stamp names', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }).map(MetaSource.makeReference), (source) => {
        expect(MetaSource.sourceOf(MetaSource.stamp(marker('m'), source))).toEqual(
          Option.some(source)
        )
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should read nothing from a resource with no meta, no source, or a source naming no source file', () => {
    // Arrange
    const withSource = (source: string | null): Marker => ({
      ...marker('m'),
      meta: { lastUpdated: null, profile: [], security: [], tag: [], versionId: null, source },
    })

    // Act
    const sources = [marker('m'), withSource(null), withSource('https://source.example/x')].map(
      MetaSource.sourceOf
    )

    // Assert
    expect(sources).toEqual([Option.none(), Option.none(), Option.none()])
  })
})

describe('MetaSource.isReference', () => {
  it('should hold a literal reference to a DocumentReference a reference, and nothing else', () => {
    // Arrange / Act
    const isReference = [
      'DocumentReference/d',
      'Patient/d',
      'https://source.example/DocumentReference/d',
    ].map(MetaSource.isReference)

    // Assert
    expect(isReference).toEqual([true, false, false])
  })
})
