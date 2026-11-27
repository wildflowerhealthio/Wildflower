import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import {
  type FhirResourceWithId,
  literalReferenceOf,
  LogicalReference,
  ResourceReferences,
} from '@wildflowerhealthio/fhir-r4/resources'
import { HashSet, Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { detached, OTHER_SOURCE, SOURCE, stored, tyraWire } from '../import-plan.test-helpers.ts'
import * as KeptRecord from './kept-record.ts'
import * as ReferenceTable from './reference-table.ts'

/**
 * Covers a kept record as merged once the import's records merge into it, in
 * order, an edit among them, and what is written for it.
 */

const storedTyra = stored({ ...tyraWire('tyra'), id: 'p-1' })

describe('KeptRecord.asMerged', () => {
  it('should be the kept record itself while nothing merges into it', () => {
    // Arrange / Act
    const asMerged = KeptRecord.asMerged(KeptRecord.make(storedTyra, []))

    // Assert
    expect(asMerged).toBe(storedTyra)
  })

  it('should lay each merge’s taken fields over the kept record, later ones winning, and join their identifiers', () => {
    // Arrange
    const first = detached(
      tyraWire('tyra', {
        gender: 'male',
        birthDate: '1991-03-04',
        identifier: [
          { system: SOURCE, value: 'tyra' },
          { system: OTHER_SOURCE, value: 'tyra-at-other' },
        ],
      })
    )
    const second = detached(tyraWire('tyra', { gender: 'female' }))
    const keptRecord = KeptRecord.make(storedTyra, [
      { incoming: first, fieldsTaken: HashSet.make('gender'), isEdit: false },
      { incoming: second, fieldsTaken: HashSet.make('gender'), isEdit: false },
    ])

    // Act
    const asMerged = KeptRecord.asMerged(keptRecord)

    // Assert
    expect(
      asMerged.resourceType === 'Patient'
        ? {
            id: asMerged.id,
            gender: asMerged.gender,
            birthDate: asMerged.birthDate,
            identifiers: asMerged.identifier.map(({ value }) => value),
          }
        : null
    ).toEqual({
      id: 'p-1',
      gender: 'female',
      birthDate: '1990-01-02',
      identifiers: ['tyra', 'tyra-at-other'],
    })
  })
})

/** A patient's gender, birth date and identifier values, or `null` for another resource. */
const demographicsOf = (resource: FhirResourceWithId): unknown =>
  resource.resourceType === 'Patient'
    ? {
        id: resource.id,
        gender: resource.gender,
        birthDate: resource.birthDate,
        identifiers: resource.identifier.map(({ value }) => value),
      }
    : null

describe('KeptRecord.asMerged, an edit among the merges', () => {
  it('should replace the kept record’s content with the last edit, lay later taken fields over it, and keep every identifier', () => {
    // Arrange
    const storedWithOther = stored({
      ...tyraWire('tyra'),
      id: 'p-1',
      identifier: [
        { system: SOURCE, value: 'tyra' },
        { system: OTHER_SOURCE, value: 'kept' },
      ],
    })
    const edit = detached(tyraWire('tyra', { gender: 'other', birthDate: '1991-01-01' }))
    const later = detached(tyraWire('tyra', { gender: 'female' }))
    const keptRecord = KeptRecord.make(storedWithOther, [
      { incoming: edit, fieldsTaken: HashSet.make('birthDate'), isEdit: true },
      { incoming: later, fieldsTaken: HashSet.make('gender'), isEdit: false },
    ])

    // Act
    const asMerged = KeptRecord.asMerged(keptRecord)

    // Assert
    expect(demographicsOf(asMerged)).toEqual({
      id: 'p-1',
      gender: 'female',
      birthDate: '1991-01-01',
      identifiers: ['tyra', 'kept'],
    })
  })
})

/** A reference table landing nothing, so no reference gains a link. */
const NO_LINKS = ReferenceTable.make({ logicalReferences: [], stageLiterals: [], sourceUrls: [] })

describe('KeptRecord.writtenOf', () => {
  it.each([
    { name: 'nothing merges into it', merge: Option.none(), written: false },
    {
      name: 'a merge takes nothing and adds no identifier',
      merge: Option.some({
        incoming: detached(tyraWire('tyra')),
        fieldsTaken: HashSet.empty(),
        isEdit: false,
      }),
      written: false,
    },
    {
      name: 'a merge only adds an identifier',
      merge: Option.some({
        incoming: detached(tyraWire('tyra-at-other', {}, OTHER_SOURCE)),
        fieldsTaken: HashSet.empty(),
        isEdit: false,
      }),
      written: true,
    },
    {
      name: 'a merge takes a field',
      merge: Option.some({
        incoming: detached(tyraWire('tyra', { gender: 'female' })),
        fieldsTaken: HashSet.make('gender'),
        isEdit: false,
      }),
      written: true,
    },
    {
      name: 'the reviewer edits it',
      merge: Option.some({
        incoming: detached(tyraWire('tyra')),
        fieldsTaken: HashSet.empty(),
        isEdit: true,
      }),
      written: true,
    },
  ])(
    'should write the kept record only when a merge writes something: $name',
    ({ merge, written }) => {
      // Arrange
      const keptRecord = KeptRecord.make(storedTyra, Option.toArray(merge))

      // Act
      const writtenForm = KeptRecord.writtenOf(NO_LINKS, keptRecord)

      // Assert
      expect(Option.map(writtenForm, literalReferenceOf)).toEqual(
        written ? Option.some('Patient/p-1') : Option.none()
      )
    }
  )
})

describe('KeptRecord.writtenOf, an unlinked reference of the kept record', () => {
  /** Tyra as the store holds her, her general practitioner named by identifier alone. */
  const storedWithUnlinked = stored({
    ...tyraWire('tyra'),
    id: 'p-1',
    generalPractitioner: [
      { type: 'Practitioner', identifier: { system: SOURCE, value: 'dr-brown' }, display: 'Dr. B' },
    ],
  })
  const drBrownReference = LogicalReference.make(
    'Practitioner',
    Option.getOrThrow(
      DetachedResource.keyIdentifierOf(
        detached({
          resourceType: 'Practitioner',
          identifier: [{ system: SOURCE, value: 'dr-brown' }],
        })
      )
    )
  )
  /** A merge that takes nothing and adds no identifier, so only a link can cause a write. */
  const mergingNothing = KeptRecord.make(storedWithUnlinked, [
    { incoming: detached(tyraWire('tyra')), fieldsTaken: HashSet.empty(), isEdit: false },
  ])
  const tableLanding = (target: ReferenceTable.Target): ReferenceTable.Type =>
    ReferenceTable.make({
      logicalReferences: [{ logicalReference: drBrownReference, target }],
      stageLiterals: [],
      sourceUrls: [],
    })

  it('should write the kept record with the reference linked, its type, identifier and display kept, when the table lands it on a literal', () => {
    // Arrange
    const table = tableLanding(ReferenceTable.Literal({ literalReference: 'Practitioner/pr-1' }))

    // Act
    const written = KeptRecord.writtenOf(table, mergingNothing)

    // Assert
    expect(
      Option.map(written, (resource) =>
        ResourceReferences.collect(resource).map(({ reference }) => ({
          reference: reference.reference,
          type: reference.type,
          identifier: reference.identifier?.value,
          display: reference.display,
        }))
      )
    ).toEqual(
      Option.some([
        {
          reference: 'Practitioner/pr-1',
          type: 'Practitioner',
          identifier: 'dr-brown',
          display: 'Dr. B',
        },
      ])
    )
  })

  it('should write nothing when the table lands the reference on a stub', () => {
    // Arrange
    const table = tableLanding(
      ReferenceTable.Stub({
        resourceType: 'Practitioner',
        keyIdentifier: Option.some(drBrownReference.identifier[0]),
        display: Option.some('Dr. Brown'),
      })
    )

    // Act
    const written = KeptRecord.writtenOf(table, mergingNothing)

    // Assert
    expect(written).toEqual(Option.none())
  })
})
