import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import { LogicalReference, ResourceReferences } from '@wildflowerhealthio/fhir-r4/resources'
import { Effect, Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { detached, SOURCE, tyraWire } from '../import-plan.test-helpers.ts'
import * as ReferenceTable from './reference-table.ts'

/**
 * Covers applying a reference table to one resource: each spelling of a
 * record landed on its target, a stub's display, and what a stub leaves.
 */

const SOURCE_URL = 'https://source.example/fhir/Binary/b-1'

const tyraReference = LogicalReference.make(
  'Patient',
  Option.getOrThrow(DetachedResource.keyIdentifierOf(detached(tyraWire('tyra'))))
)

/** A source file naming Tyra by her stage literal, its attachment by the source's URL, read from `source`. */
const sourceFile = detached({
  resourceType: 'DocumentReference',
  status: 'current',
  meta: { source: 'DocumentReference/stage-file' },
  subject: { reference: 'Patient/stage-tyra' },
  author: [{ reference: 'Binary/stage-binary' }],
  content: [{ attachment: { contentType: 'text/plain', url: SOURCE_URL } }],
})

const resolve = <TResource extends DetachedResource.Type>(
  table: ReferenceTable.Type,
  resource: TResource
): TResource => Effect.runSync(ReferenceTable.resolve(table, resource))

describe('ReferenceTable.resolve', () => {
  it('should land each spelling of a record with a literal target on its literal', () => {
    // Arrange
    const table = ReferenceTable.make({
      logicalReferences: [],
      stageLiterals: [
        ['Patient/stage-tyra', ReferenceTable.Literal({ literalReference: 'Patient/p-1' })],
        [
          'DocumentReference/stage-file',
          ReferenceTable.Literal({ literalReference: 'DocumentReference/f-1' }),
        ],
      ],
      sourceUrls: [
        [new URL(SOURCE_URL), ReferenceTable.Literal({ literalReference: 'Binary/b-new' })],
      ],
    })

    // Act
    const resolved = resolve(table, sourceFile)

    // Assert
    expect(resolved).toMatchObject({
      meta: { source: 'DocumentReference/f-1' },
      subject: { reference: 'Patient/p-1' },
      content: [{ attachment: { url: 'Binary/b-new' } }],
    })
  })

  it('should make a stage literal a stub by the record’s key, keep a keyless record’s literal, and leave a source URL and meta.source with a stub target as they are', () => {
    // Arrange
    const stub = (keyedBy: Option.Option<LogicalReference.Type>): ReferenceTable.Target =>
      ReferenceTable.Stub({ display: Option.some('Tyra Ashford'), keyedBy })
    const table = ReferenceTable.make({
      logicalReferences: [],
      stageLiterals: [
        ['Patient/stage-tyra', stub(Option.some(tyraReference))],
        ['Binary/stage-binary', stub(Option.none())],
        ['DocumentReference/stage-file', stub(Option.none())],
      ],
      sourceUrls: [[new URL(SOURCE_URL), stub(Option.none())]],
    })

    // Act
    const resolved = resolve(table, sourceFile)

    // Assert
    expect(resolved).toMatchObject({
      meta: { source: 'DocumentReference/stage-file' },
      subject: {
        reference: null,
        type: 'Patient',
        identifier: { value: 'tyra' },
        display: 'Tyra Ashford',
      },
      author: [{ reference: 'Binary/stage-binary' }],
      content: [{ attachment: { url: SOURCE_URL } }],
    })
  })

  it('should give a logical reference to a stub the stub’s display only when it has none of its own', () => {
    // Arrange
    const table = ReferenceTable.make({
      logicalReferences: [
        [
          tyraReference,
          ReferenceTable.Stub({
            display: Option.some('Tyra Ashford'),
            keyedBy: Option.some(tyraReference),
          }),
        ],
      ],
      stageLiterals: [],
      sourceUrls: [],
    })
    const named = (display: string | null): DetachedResource.Type =>
      detached({
        resourceType: 'Observation',
        status: 'final',
        code: { text: 'A1c' },
        subject: { type: 'Patient', identifier: { system: SOURCE, value: 'tyra' }, display },
      })

    // Act
    const displays = [named(null), named('T. Ashford')].map((resource) =>
      ResourceReferences.collect(resolve(table, resource)).map(({ reference }) => reference.display)
    )

    // Assert
    expect(displays).toEqual([['Tyra Ashford'], ['T. Ashford']])
  })

  it('should write no display on a stub that has none, by a logical reference or a stage literal', () => {
    // Arrange
    const noDisplay = ReferenceTable.Stub({
      display: Option.none(),
      keyedBy: Option.some(tyraReference),
    })
    const table = ReferenceTable.make({
      logicalReferences: [[tyraReference, noDisplay]],
      stageLiterals: [['Patient/stage-tyra', noDisplay]],
      sourceUrls: [],
    })
    const naming = (subject: object): DetachedResource.Type =>
      detached({ resourceType: 'Observation', status: 'final', code: { text: 'A1c' }, subject })

    // Act
    const subjects = [
      naming({ type: 'Patient', identifier: { system: SOURCE, value: 'tyra' } }),
      naming({ reference: 'Patient/stage-tyra' }),
    ].map((resource) =>
      ResourceReferences.collect(resolve(table, resource)).map(({ reference }) => ({
        reference: reference.reference,
        display: reference.display,
      }))
    )

    // Assert
    expect(subjects).toEqual([
      [{ reference: null, display: null }],
      [{ reference: null, display: null }],
    ])
  })
})
