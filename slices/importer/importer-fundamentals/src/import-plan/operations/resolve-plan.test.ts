import {
  FhirResourceSchema,
  type FhirResourceWithId,
  literalReferenceOf,
  ResourceReferences,
} from '@wildflowerhealthio/fhir-r4/resources'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { HashSet, Option, Schema } from 'effect'
import fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import * as ImportPlan from '../entities/import-plan.ts'
import * as ImportWrite from '../entities/import-write.ts'
import * as ImportedCopy from '../entities/imported-copy.ts'
import * as RecordChoice from '../entities/record-choice.ts'
import * as StoredMatch from '../entities/stored-match.ts'
import {
  candidate,
  copyOf,
  detached,
  drBrown,
  OTHER_SOURCE,
  prescription,
  prescriptionWire,
  NAMES,
  SOURCE,
  stored,
  storedBrown,
  storedTyra,
  tyraA as tyra,
  tyraWire,
} from '../import-plan.test-helpers.ts'
import { planOf, planWith, resolutionOf, resolvedOf } from './resolve-plan.test-helpers.ts'

/**
 * Covers resolving a plan: the id each record is written under, what each
 * choice writes, records that use one stored record writing it once, and
 * when a record a reference only implied is written.
 */

/** A stored match holding `underDerivedId` under `copy`'s derived id, and `candidates` for it. */
const storedUnder = (
  copy: ImportedCopy.Type,
  underDerivedId: FhirResourceWithId,
  candidates: Parameters<typeof StoredMatch.makeEntry>[0] = []
): StoredMatch.Type =>
  StoredMatch.make({
    records: [
      {
        key: ImportedCopy.recordKeyOf(copy),
        entry: StoredMatch.makeEntry(candidates, Option.some(underDerivedId)),
      },
    ],
    externalReferences: [],
  })

/** The written form of `copy`'s record in `plan` as wire JSON, or `None`. */
const writtenWireOf = (plan: ImportPlan.Type, copy: ImportedCopy.Type): Option.Option<unknown> =>
  Option.map(resolvedOf(resolutionOf(plan), copy).written, (resource) =>
    Schema.encodeSync(FhirResourceSchema)(resource)
  )

/** The literal reference of every resource `plan`'s write writes, in plan order. */
const writtenReferencesOf = (plan: ImportPlan.Type): readonly string[] =>
  ImportWrite.match(ImportWrite.of(resolutionOf(plan)), {
    Ready: ({ resources }) => resources.map(literalReferenceOf),
    Blocked: () => [],
  })

const useStoredTyra = (fieldsTaken: readonly string[] = []): RecordChoice.Type =>
  RecordChoice.MergeIntoExistingRecord({
    existing: storedTyra,
    fieldsTaken: HashSet.fromIterable(fieldsTaken),
  })

describe('resolvePlan, the id each record is written under', () => {
  it('should write a record saved as new under the id the import stage gave it', () => {
    // Arrange
    const plan = planWith([tyra])

    // Act
    const resolved = resolvedOf(resolutionOf(plan), tyra)

    // Assert
    expect({
      id: resolved.id,
      written: Option.map(resolved.written, literalReferenceOf),
    }).toEqual({
      id: Option.some(tyra.stageId.id),
      written: Option.some(`Patient/${tyra.stageId.id}`),
    })
  })

  it('should mint an id for a record saved as new over the stored record under its derived id, and leave that record unwritten', () => {
    // Arrange
    const underDerivedId = stored({ ...tyraWire('tyra'), identifier: [], id: tyra.stageId.id })
    const plan = planWith(
      [tyra],
      [[tyra, RecordChoice.SaveAsNewRecord()]],
      storedUnder(tyra, underDerivedId)
    )

    // Act
    const resolved = resolvedOf(resolutionOf(plan), tyra)

    // Assert
    expect({
      id: resolved.id,
      written: Option.map(resolved.written, literalReferenceOf),
    }).toEqual({ id: Option.some('minted-1'), written: Option.some('Patient/minted-1') })
  })

  it.each([
    {
      name: 'found by identifier and sitting under its derived id',
      candidates: (underDerivedId: FhirResourceWithId) => [
        candidate(underDerivedId, 'certain', 'identifier'),
      ],
    },
    {
      name: 'among several found by identifier, one under its derived id',
      candidates: (underDerivedId: FhirResourceWithId) => [
        candidate(underDerivedId, 'probable', 'identifier'),
        candidate(stored({ ...tyraWire('tyra'), id: 'p-2' }), 'probable', 'identifier'),
      ],
    },
  ])(
    'should mint an id for a record saved as new over a stored record $name, and write nothing under the stored id',
    ({ candidates }) => {
      // Arrange
      const underDerivedId = stored({ ...tyraWire('tyra'), id: tyra.stageId.id })
      const plan = planWith(
        [tyra],
        [[tyra, RecordChoice.SaveAsNewRecord()]],
        storedUnder(tyra, underDerivedId, candidates(underDerivedId))
      )

      // Act
      const written = writtenReferencesOf(plan)

      // Assert
      expect(written).toEqual(['Patient/minted-1'])
    }
  )

  it('should write a record saved as new under a minted id and another that merges into the stored record under its id, never two under one', () => {
    // Arrange
    const other = copyOf(detached(tyraWire('tyra-b', { gender: 'female' }, OTHER_SOURCE)), 'tyra-b')
    const underDerivedId = stored({ ...tyraWire('tyra'), id: tyra.stageId.id })
    const plan = planWith(
      [tyra, other],
      [
        [tyra, RecordChoice.SaveAsNewRecord()],
        [
          other,
          RecordChoice.MergeIntoExistingRecord({
            existing: underDerivedId,
            fieldsTaken: HashSet.make('gender'),
          }),
        ],
      ],
      storedUnder(tyra, underDerivedId)
    )

    // Act
    const written = writtenReferencesOf(plan)

    // Assert
    expect(written.toSorted()).toEqual(
      ['Patient/minted-1', `Patient/${tyra.stageId.id}`].toSorted()
    )
  })
})

describe('resolvePlan, what each choice writes', () => {
  it('should write a record with every qualified identifier its decoded copies carry, the record copy’s first', () => {
    // Arrange
    const fromA = copyOf(
      detached(
        tyraWire('tyra', {
          identifier: [
            { system: SOURCE, value: 'tyra' },
            { system: OTHER_SOURCE, value: 'mrn-7' },
          ],
        })
      ),
      'tyra',
      'a.har'
    )
    const fromB = copyOf(detached(tyraWire('tyra')), 'tyra', 'b.pdf')
    const plan = planWith([fromA, fromB])

    // Act
    const written = writtenWireOf(plan, fromB)

    // Assert
    expect(written).toMatchObject(
      Option.some({
        identifier: [
          { system: SOURCE, value: 'tyra' },
          { system: OTHER_SOURCE, value: 'mrn-7' },
        ],
      })
    )
  })

  it('should point `meta.source` at its source file saved as new under a minted id', () => {
    // Arrange
    const sourceFile = copyOf(
      detached({
        resourceType: 'DocumentReference',
        status: 'current',
        content: [{ attachment: { contentType: 'text/plain' } }],
      }),
      'source-file',
      'a.har',
      { stageId: { _tag: 'Derived', id: 'source-file-id' } }
    )
    const stamped = copyOf(
      detached({ ...tyraWire('tyra'), meta: { source: 'DocumentReference/source-file-id' } }),
      'tyra'
    )
    const plan = planWith(
      [sourceFile, stamped],
      [[sourceFile, RecordChoice.SaveAsNewRecord()]],
      storedUnder(
        sourceFile,
        stored({
          resourceType: 'DocumentReference',
          id: 'source-file-id',
          status: 'current',
          content: [{ attachment: { contentType: 'application/pdf' } }],
        })
      )
    )

    // Act
    const written = writtenWireOf(plan, stamped)

    // Assert
    expect(written).toMatchObject(Option.some({ meta: { source: 'DocumentReference/minted-1' } }))
  })

  it('should write the stored record with the taken fields and the import’s new identifiers', () => {
    // Arrange
    const imported = copyOf(
      detached(
        tyraWire('tyra', {
          gender: 'female',
          birthDate: '1990-01-03',
          identifier: [
            { system: SOURCE, value: 'tyra' },
            { system: OTHER_SOURCE, value: 'tyra-at-other' },
          ],
        })
      ),
      'tyra'
    )
    const plan = planWith([imported], [[imported, useStoredTyra(['gender'])]])

    // Act
    const written = writtenWireOf(plan, imported)

    // Assert
    expect(written).toMatchObject(
      Option.some({
        id: 'p-1',
        gender: 'female',
        birthDate: '1990-01-02',
        identifier: [
          { system: SOURCE, value: 'tyra' },
          { system: OTHER_SOURCE, value: 'tyra-at-other' },
        ],
      })
    )
  })

  it('should write the stored record with only an added identifier when nothing is taken', () => {
    // Arrange
    const imported = copyOf(detached(tyraWire('tyra-at-other', {}, OTHER_SOURCE)), 'tyra')
    const plan = planWith([imported], [[imported, useStoredTyra()]])

    // Act
    const written = writtenWireOf(plan, imported)

    // Assert
    expect(written).toMatchObject(
      Option.some({
        id: 'p-1',
        identifier: [{ value: 'tyra' }, { system: OTHER_SOURCE, value: 'tyra-at-other' }],
      })
    )
  })

  it('should write nothing for a record that links to a stored record and adds nothing', () => {
    // Arrange
    const plan = planWith([tyra], [[tyra, useStoredTyra()]])

    // Act
    const resolved = resolvedOf(resolutionOf(plan), tyra)

    // Assert
    expect({ id: resolved.id, written: resolved.written, label: resolved.label }).toEqual({
      id: Option.some('p-1'),
      written: Option.none(),
      label: 'LinkToExisting',
    })
  })

  it('should write an edited record that merges into a stored record whole under its id, the stored identifiers kept', () => {
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
    const plan = ImportPlan.setEdit(
      planWith(
        [tyra],
        [
          [
            tyra,
            RecordChoice.MergeIntoExistingRecord({
              existing: storedWithOther,
              fieldsTaken: HashSet.empty(),
            }),
          ],
        ]
      ),
      ImportedCopy.recordKeyOf(tyra),
      Option.some(edit)
    )

    // Act
    const written = writtenWireOf(plan, tyra)

    // Assert
    expect(written).toMatchObject(
      Option.some({
        id: 'p-1',
        gender: 'other',
        birthDate: '1991-01-01',
        identifier: [
          { system: SOURCE, value: 'tyra' },
          { system: OTHER_SOURCE, value: 'kept' },
        ],
      })
    )
  })

  it('should write an edited record saved as new as edited, under its id', () => {
    // Arrange
    const edit = detached(tyraWire('tyra', { gender: 'other', birthDate: '1991-01-01' }))
    const plan = ImportPlan.setEdit(
      planWith([tyra], [[tyra, RecordChoice.SaveAsNewRecord()]]),
      ImportedCopy.recordKeyOf(tyra),
      Option.some(edit)
    )

    // Act
    const written = writtenWireOf(plan, tyra)

    // Assert
    expect(written).toMatchObject(
      Option.some({ id: tyra.stageId.id, gender: 'other', birthDate: '1991-01-01' })
    )
  })

  it('should resolve a reference an edit holds in what is written', () => {
    // Arrange
    const edit = detached({
      ...prescriptionWire('rx-1', { system: NAMES, value: 'Dr. Brown' }),
      medicationCodeableConcept: { text: 'Metformin XR' },
    })
    const plan = ImportPlan.setEdit(
      planWith([prescription, tyra]),
      ImportedCopy.recordKeyOf(prescription),
      Option.some(edit)
    )

    // Act
    const written = writtenWireOf(plan, prescription)

    // Assert
    expect(written).toMatchObject(
      Option.some({
        id: prescription.stageId.id,
        medicationCodeableConcept: { text: 'Metformin XR' },
        subject: { reference: `Patient/${tyra.stageId.id}` },
      })
    )
  })

  it('should write two records that use one stored record as one write, later fields winning, every identifier added', () => {
    // Arrange
    const first = copyOf(detached(tyraWire('tyra', { gender: 'female' })), 'tyra')
    const second = copyOf(
      detached(tyraWire('tyra-b', { gender: 'male' }, OTHER_SOURCE)),
      'tyra-b',
      'b.pdf'
    )
    const plan = planWith(
      [first, second],
      [
        [first, useStoredTyra(['gender'])],
        [second, useStoredTyra(['gender'])],
      ]
    )

    // Act
    const resolution = resolutionOf(plan)
    const writes = resolution.records.flatMap(({ written }) => Option.toArray(written))

    // Assert
    expect({
      distinct: new Set(writes.map(literalReferenceOf)),
      written: writes.map((resource) => Schema.encodeSync(FhirResourceSchema)(resource))[0],
    }).toMatchObject({
      distinct: new Set(['Patient/p-1']),
      written: {
        gender: 'male',
        identifier: [{ value: 'tyra' }, { system: OTHER_SOURCE, value: 'tyra-b' }],
      },
    })
  })

  it('should make a decoded record’s merge into a stored record before an implied one’s, whatever their plan order, as the suggestions did', () => {
    // Arrange
    const decodedBrown = copyOf(
      detached({
        resourceType: 'Practitioner',
        identifier: [{ system: OTHER_SOURCE, value: 'brown' }],
        name: [{ family: 'Brown', given: ['Alex'] }],
      }),
      'brown',
      'b.pdf'
    )
    const useStoredBrownTakingName = RecordChoice.MergeIntoExistingRecord({
      existing: storedBrown,
      fieldsTaken: HashSet.make('name'),
    })
    const plan = planWith(
      [prescription, drBrown, decodedBrown],
      [
        [drBrown, useStoredBrownTakingName],
        [decodedBrown, useStoredBrownTakingName],
      ]
    )

    // Act
    const written = writtenWireOf(plan, decodedBrown)

    // Assert
    expect(written).toMatchObject(Option.some({ name: [{ text: 'Dr. Brown' }] }))
  })

  it('should write nothing for a record that is not added', () => {
    // Arrange
    const plan = planWith([tyra], [[tyra, RecordChoice.DontAdd()]])

    // Act
    const resolved = resolvedOf(resolutionOf(plan), tyra)

    // Assert
    expect({ id: resolved.id, written: resolved.written }).toEqual({
      id: Option.none(),
      written: Option.none(),
    })
  })
})

describe('resolvePlan, a stored record’s unlinked references', () => {
  /** A stored prescription naming Tyra by a name-only stub, as "don't add" left it. */
  const storedWithStub = stored({
    ...prescriptionWire('rx-1', { system: NAMES, value: 'Dr. Brown' }),
    id: 'm-1',
    subject: {
      type: 'Patient',
      identifier: { system: SOURCE, value: 'tyra' },
      display: 'Tyra Ashford',
    },
  })
  const useStoredPrescription = RecordChoice.MergeIntoExistingRecord({
    existing: storedWithStub,
    fieldsTaken: HashSet.empty(),
  })

  it('should link a stored record’s reference to the target the import saves as new, and write it though nothing is taken', () => {
    // Arrange
    const plan = planWith(
      [prescription, tyra],
      [
        [prescription, useStoredPrescription],
        [tyra, RecordChoice.SaveAsNewRecord()],
      ]
    )

    // Act
    const resolved = resolvedOf(resolutionOf(plan), prescription)

    // Assert
    expect({
      label: resolved.label,
      subject: Option.map(resolved.written, (written) =>
        written.resourceType === 'MedicationRequest' ? written.subject : null
      ),
    }).toMatchObject({
      label: 'Update',
      subject: Option.some({
        reference: `Patient/${tyra.stageId.id}`,
        type: 'Patient',
        identifier: { value: 'tyra' },
        display: 'Tyra Ashford',
      }),
    })
  })

  it('should not write a stored record for a reference whose target is not added', () => {
    // Arrange
    const plan = planWith(
      [prescription, tyra],
      [
        [prescription, useStoredPrescription],
        [tyra, RecordChoice.DontAdd()],
      ]
    )

    // Act
    const resolved = resolvedOf(resolutionOf(plan), prescription)

    // Assert
    expect({ label: resolved.label, written: resolved.written }).toEqual({
      label: 'LinkToExisting',
      written: Option.none(),
    })
  })
})

describe('resolvePlan, a record a reference only implied', () => {
  it('should write it only while a written record names it, else label it unneeded', () => {
    // Arrange
    const kept = planWith([prescription, drBrown])
    const notNamed = planWith([prescription, drBrown], [[prescription, RecordChoice.DontAdd()]])

    // Act
    const keptBrown = resolvedOf(resolutionOf(kept), drBrown)
    const notNamedBrown = resolvedOf(resolutionOf(notNamed), drBrown)

    // Assert
    expect([
      [Option.isSome(keptBrown.written), keptBrown.label],
      [Option.isSome(notNamedBrown.written), notNamedBrown.label],
    ]).toEqual([
      [true, 'Create'],
      [false, 'Unneeded'],
    ])
  })

  it('should label it by its choice, not unneeded, when it merges into a stored record it has nothing to add to and nothing written names it', () => {
    // Arrange
    const storedBrownCarryingHisName = stored({
      resourceType: 'Practitioner',
      id: 'pr-2',
      identifier: [{ system: NAMES, value: 'Dr. Brown' }],
      name: [{ text: 'Dr. Brown' }],
    })
    const plan = planWith(
      [prescription, drBrown],
      [
        [prescription, RecordChoice.DontAdd()],
        [
          drBrown,
          RecordChoice.MergeIntoExistingRecord({
            existing: storedBrownCarryingHisName,
            fieldsTaken: HashSet.empty(),
          }),
        ],
      ]
    )

    // Act
    const resolved = resolvedOf(resolutionOf(plan), drBrown)

    // Assert
    expect({ label: resolved.label, written: resolved.written }).toEqual({
      label: 'LinkToExisting',
      written: Option.none(),
    })
  })

  it('should leave a stored record it merges into unchanged when nothing written names it', () => {
    // Arrange
    const brownWithLicence = copyOf(
      detached({
        resourceType: 'Practitioner',
        identifier: [
          { system: NAMES, value: 'Dr. Brown' },
          { system: SOURCE, value: 'licence-7' },
        ],
        name: [{ text: 'Dr. Brown' }],
      }),
      'rx-1#implied',
      'a.har',
      { isImplied: true }
    )
    const plan = planWith(
      [prescription, brownWithLicence],
      [
        [prescription, RecordChoice.DontAdd()],
        [
          brownWithLicence,
          RecordChoice.MergeIntoExistingRecord({
            existing: storedBrown,
            fieldsTaken: HashSet.empty(),
          }),
        ],
      ]
    )

    // Act
    const resolved = resolvedOf(resolutionOf(plan), brownWithLicence)

    // Assert
    expect({ label: resolved.label, written: resolved.written }).toEqual({
      label: 'Unneeded',
      written: Option.none(),
    })
  })
})

/** A choice a reviewer can make for a record of `existing`'s type: save as new, don't add, or use `existing`. */
const choiceArbitrary = (existing: FhirResourceWithId): fc.Arbitrary<RecordChoice.Type> =>
  fc.constantFrom(
    RecordChoice.SaveAsNewRecord(),
    RecordChoice.DontAdd(),
    RecordChoice.MergeIntoExistingRecord({ existing, fieldsTaken: HashSet.make('name') }),
    RecordChoice.MergeIntoExistingRecord({ existing, fieldsTaken: HashSet.empty() })
  )

const result = copyOf(
  detached({
    resourceType: 'Observation',
    identifier: [{ system: SOURCE, value: 'a1c' }],
    status: 'final',
    code: { text: 'A1c' },
    subject: { type: 'Patient', identifier: { system: SOURCE, value: 'tyra' } },
  }),
  'a1c',
  'report.pdf'
)
const storedPrescription = stored({
  ...prescriptionWire('rx-0', { system: NAMES, value: 'x' }),
  id: 'm-1',
})
const storedResult = stored({
  resourceType: 'Observation',
  id: 'o-1',
  status: 'final',
  code: { text: 'A1c' },
})
const storedUnderTyrasDerivedId = stored({ ...tyraWire('tyra'), id: tyra.stageId.id })

/** Whether `literal` is a relative `Type/id` reference: a stored or written resource, not a URL. */
const isRelative = (literal: string): boolean => !literal.includes('://')

describe('resolvePlan properties', () => {
  it('should write each id once, name only written or used stored resources, and write no stored resource the plan does not use', () => {
    fc.assert(
      fc.property(
        fc.tuple(
          choiceArbitrary(storedPrescription),
          choiceArbitrary(storedBrown),
          choiceArbitrary(storedTyra),
          choiceArbitrary(storedResult)
        ),
        (choices) => {
          // Arrange
          const suggested = planOf(
            [prescription, drBrown, tyra, result],
            storedUnder(tyra, storedUnderTyrasDerivedId)
          )
          const plan = suggested.records.reduce(
            (chosen, { record }, index) =>
              ImportPlan.choose(chosen, [record.key], choices[index] ?? RecordChoice.DontAdd()),
            suggested
          )

          // Act
          const write = ImportWrite.of(resolutionOf(plan))

          // Assert
          const resources = ImportWrite.match(write, {
            Ready: (ready) => ready.resources,
            Blocked: (): readonly FhirResourceWithId[] => [],
          })
          const written = resources.map(literalReferenceOf)
          const used = choices.flatMap((choice) =>
            choice._tag === 'MergeIntoExistingRecord' ? [literalReferenceOf(choice.existing)] : []
          )
          const storedLiterals = [
            storedPrescription,
            storedBrown,
            storedTyra,
            storedResult,
            storedUnderTyrasDerivedId,
          ].map(literalReferenceOf)
          const named = new Set([...written, ...used])
          const literals = resources.flatMap((resource) =>
            ResourceReferences.collect(resource).flatMap(({ reference }) =>
              reference.reference === null ? [] : [reference.reference]
            )
          )
          expect({
            repeatedIds: written.filter((literal, index) => written.indexOf(literal) !== index),
            unnamed: literals.filter(isRelative).filter((literal) => !named.has(literal)),
            unusedStoredWritten: written.filter(
              (literal) => storedLiterals.includes(literal) && !used.includes(literal)
            ),
          }).toEqual({ repeatedIds: [], unnamed: [], unusedStoredWritten: [] })
        }
      ),
      { numRuns: numRunsFor({ base: 60 }) }
    )
  })
})
