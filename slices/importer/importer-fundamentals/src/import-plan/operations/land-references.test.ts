import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import type { ResourceMatch } from '@wildflowerhealthio/fhir-r4/clients'
import { LogicalReference, ResourceReferences } from '@wildflowerhealthio/fhir-r4/resources'
import { Effect, HashMap, HashSet, Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import type * as ImportPlan from '../entities/import-plan.ts'
import * as ImportedCopy from '../entities/imported-copy.ts'
import * as RecordChoice from '../entities/record-choice.ts'
import type * as RecordKey from '../entities/record-key.ts'
import * as ReferenceTable from '../entities/reference-table.ts'
import * as StoredMatch from '../entities/stored-match.ts'
import {
  candidate,
  copyOf,
  detached,
  drBrown,
  OTHER_SOURCE,
  prescription,
  SOURCE,
  storedBrown,
  storedTyra,
  tyraA as tyra,
  tyraWire,
} from '../import-plan.test-helpers.ts'
import { landReferences } from './land-references.ts'
import { planWith } from './resolve-plan.test-helpers.ts'

/**
 * Covers where a reference lands for each choice of the record it names, by
 * every spelling a copy names a record by, and what a stub shows.
 */

type Ids = readonly (readonly [ImportedCopy.Type, string])[]

/** The ids `ids` gives each copy's record, by key. */
const idsOf = (ids: Ids): HashMap.HashMap<RecordKey.Type, string> =>
  HashMap.fromIterable(ids.map(([copy, id]) => [ImportedCopy.recordKeyOf(copy), id] as const))

/** `resource` resolved by the reference table `plan` lands, its records under `ids`. */
const resolvedBy = <TResource extends DetachedResource.Type>(
  plan: ImportPlan.Type,
  ids: Ids,
  resource: TResource
): TResource => ReferenceTable.resolve(Effect.runSync(landReferences(plan, idsOf(ids))), resource)

/** The reference `resource` holds at `path` once resolved by the table `plan` lands. */
const landedAt = (
  plan: ImportPlan.Type,
  ids: Ids,
  resource: DetachedResource.Type,
  path: string
): unknown =>
  ResourceReferences.collect(resolvedBy(plan, ids, resource)).find((at) => at.path === path)
    ?.reference

const useStoredTyra = RecordChoice.MergeIntoExistingRecord({
  existing: storedTyra,
  fieldsTaken: HashSet.empty(),
})

describe('landReferences, a logical reference to a record of the import', () => {
  it('should land on a literal to the record saved as new, under its id', () => {
    // Arrange
    const plan = planWith([prescription, tyra])

    // Act
    const subject = landedAt(plan, [[tyra, 'new-tyra']], prescription.resource, 'subject')

    // Assert
    expect(subject).toMatchObject({ reference: 'Patient/new-tyra', type: 'Patient' })
  })

  it('should land on a literal to the stored record the record merges into', () => {
    // Arrange
    const plan = planWith([prescription, tyra], [[tyra, useStoredTyra]])

    // Act
    const subject = landedAt(plan, [[tyra, 'p-1']], prescription.resource, 'subject')

    // Assert
    expect(subject).toMatchObject({ reference: 'Patient/p-1' })
  })

  it('should leave a name-only stub, shown by the person’s name, for a Patient that is not added', () => {
    // Arrange
    const plan = planWith([prescription, tyra], [[tyra, RecordChoice.DontAdd()]])

    // Act
    const subject = landedAt(plan, [], prescription.resource, 'subject')

    // Assert
    expect(subject).toMatchObject({
      reference: null,
      type: 'Patient',
      identifier: { value: 'tyra' },
      display: 'Tyra Ashford',
    })
  })

  it('should write no display on the stub of a record that is not a person, never the literal it is not written under', () => {
    // Arrange
    const fill = copyOf(
      detached({
        resourceType: 'MedicationDispense',
        identifier: [{ system: SOURCE, value: 'fill-1' }],
        status: 'completed',
        medicationCodeableConcept: { text: 'Metformin' },
        authorizingPrescription: [
          { type: 'MedicationRequest', identifier: { system: SOURCE, value: 'rx-1' } },
        ],
      }),
      'fill-1'
    )
    const plan = planWith([fill, prescription], [[prescription, RecordChoice.DontAdd()]])

    // Act
    const authorizing = landedAt(plan, [], fill.resource, 'authorizingPrescription[0]')

    // Assert
    expect(authorizing).toMatchObject({
      reference: null,
      type: 'MedicationRequest',
      identifier: { value: 'rx-1' },
      display: null,
    })
  })

  it('should keep the reference’s own display on the stub of a record that is not added', () => {
    // Arrange
    const plan = planWith([prescription, drBrown], [[drBrown, RecordChoice.DontAdd()]])

    // Act
    const requester = landedAt(plan, [], prescription.resource, 'requester')

    // Assert
    expect(requester).toMatchObject({ reference: null, display: 'Dr. Brown' })
  })

  it('should leave a reference to a record with no choice logical', () => {
    // Arrange
    const plan = planWith(
      [prescription, drBrown],
      [],
      StoredMatch.make({
        records: [
          [
            ImportedCopy.recordKeyOf(drBrown),
            StoredMatch.makeEntry(
              [
                candidate(storedBrown, 'probable', 'name'),
                candidate({ ...storedBrown, id: 'pr-2' }, 'probable', 'name'),
              ],
              Option.none()
            ),
          ],
        ],
        references: [],
      })
    )

    // Act
    const requester = landedAt(plan, [], prescription.resource, 'requester')

    // Assert
    expect(requester).toMatchObject({ reference: null, display: 'Dr. Brown' })
  })

  /** A Patient keyed by `value` in {@link OTHER_SOURCE}, carrying Tyra's identifier in {@link SOURCE} too. */
  const carryingTyra = (value: string): ReturnType<typeof copyOf> =>
    copyOf(
      detached(
        tyraWire(
          value,
          {
            identifier: [
              { system: OTHER_SOURCE, value },
              { system: SOURCE, value: 'tyra' },
            ],
          },
          OTHER_SOURCE
        )
      ),
      value
    )

  it('should land a reference by an identifier two records of the import share on the one keyed by it', () => {
    // Arrange
    const twin = carryingTyra('twin')
    const plan = planWith([prescription, tyra, twin])

    // Act
    const subject = landedAt(
      plan,
      [
        [tyra, 'new-tyra'],
        [twin, 'new-twin'],
      ],
      prescription.resource,
      'subject'
    )

    // Assert
    expect(subject).toMatchObject({ reference: 'Patient/new-tyra' })
  })

  it('should leave a reference by an identifier two records of the import share, neither keyed by it, logical', () => {
    // Arrange
    const twin = carryingTyra('twin')
    const otherTwin = carryingTyra('other-twin')
    const plan = planWith([prescription, twin, otherTwin])

    // Act
    const subject = landedAt(
      plan,
      [
        [twin, 'new-twin'],
        [otherTwin, 'new-other-twin'],
      ],
      prescription.resource,
      'subject'
    )

    // Assert
    expect(subject).toMatchObject({ reference: null })
  })
})

describe('landReferences, a logical reference naming no record of the import', () => {
  it.each([
    { name: 'one stored record found by identifier', count: 1, reference: 'Patient/p-1' },
    { name: 'several', count: 2, reference: null },
    { name: 'none', count: 0, reference: null },
  ])('should land when the store holds $name', ({ count, reference }) => {
    // Arrange
    const tyraReference = LogicalReference.make(
      'Patient',
      Option.getOrThrow(DetachedResource.keyIdentifierOf(tyra.resource))
    )
    const candidates: readonly ResourceMatch.Candidate[] = [
      candidate(storedTyra, count > 1 ? 'probable' : 'certain', 'identifier'),
      candidate({ ...storedTyra, id: 'p-2' }, 'probable', 'identifier'),
    ].slice(0, count)
    const plan = planWith(
      [prescription],
      [],
      StoredMatch.make({ records: [], references: [[tyraReference, candidates]] })
    )

    // Act
    const subject = landedAt(plan, [], prescription.resource, 'subject')

    // Assert
    expect(subject).toMatchObject({ reference })
  })
})

describe('landReferences, a record’s stage literal, source URL and meta.source', () => {
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

  /** A source file filed under Tyra by her stage literal, as DICOM's hook files one. */
  const filedUnderTyra = detached({
    resourceType: 'DocumentReference',
    status: 'current',
    subject: { reference: `Patient/${tyra.stageId.id}` },
    content: [{ attachment: { contentType: 'text/plain' } }],
  })

  it('should land a reference by a record’s stage literal where the record’s choice puts it', () => {
    // Arrange
    const plan = planWith([sourceFile, tyra], [[tyra, useStoredTyra]])

    // Act
    const subject = landedAt(plan, [[tyra, 'p-1']], filedUnderTyra, 'subject')

    // Assert
    expect(subject).toMatchObject({ reference: 'Patient/p-1' })
  })

  it('should make a reference by the stage literal of a record not added a stub by its key', () => {
    // Arrange
    const plan = planWith([sourceFile, tyra], [[tyra, RecordChoice.DontAdd()]])

    // Act
    const subject = landedAt(plan, [], filedUnderTyra, 'subject')

    // Assert
    expect(subject).toMatchObject({
      reference: null,
      type: 'Patient',
      identifier: { value: 'tyra' },
      display: 'Tyra Ashford',
    })
  })

  it('should point an attachment at the Binary saved as new, and leave it on the source’s URL when the Binary is not added', () => {
    // Arrange
    const sourceUrl = 'https://source.example/fhir/Binary/b-1'
    const binary = copyOf(
      detached({ resourceType: 'Binary', contentType: 'text/plain' }),
      'b-1',
      'a.har',
      {
        sourceUrl: Option.some(new URL(sourceUrl)),
      }
    )
    const document = detached({
      resourceType: 'DocumentReference',
      identifier: [{ system: SOURCE, value: 'doc-1' }],
      status: 'current',
      content: [{ attachment: { url: sourceUrl } }],
    })

    // Act
    const saved = resolvedBy(planWith([binary]), [[binary, 'new-binary']], document)
    const notAdded = resolvedBy(
      planWith([binary], [[binary, RecordChoice.DontAdd()]]),
      [],
      document
    )

    // Assert
    expect([saved, notAdded]).toMatchObject([
      { content: [{ attachment: { url: 'Binary/new-binary' } }] },
      { content: [{ attachment: { url: sourceUrl } }] },
    ])
  })

  it('should land a reference by the stage literal of any copy of a record a source served at one URL', () => {
    // Arrange
    const binaryCopy = (fileName: string): ImportedCopy.Type =>
      copyOf(detached({ resourceType: 'Binary', contentType: 'text/plain' }), 'b-1', fileName, {
        sourceUrl: Option.some(new URL('https://source.example/fhir/Binary/b-1')),
      })
    const [first, second] = [binaryCopy('a.har'), binaryCopy('b.har')]
    const byFirstCopy = detached({
      resourceType: 'DocumentReference',
      status: 'current',
      relatesTo: [{ code: 'appends', target: { reference: `Binary/${first.stageId.id}` } }],
      content: [{ attachment: { contentType: 'text/plain' } }],
    })

    // Act
    const target = landedAt(
      planWith([first, second]),
      [[second, 'new-binary']],
      byFirstCopy,
      'relatesTo[0].target'
    )

    // Assert
    expect(target).toMatchObject({ reference: 'Binary/new-binary' })
  })

  it('should point `meta.source` at its source file where the source file is written', () => {
    // Arrange
    const stamped = detached({
      ...tyraWire('tyra'),
      meta: { source: 'DocumentReference/source-file-id' },
    })
    const plan = planWith([sourceFile])

    // Act
    const resolved = resolvedBy(plan, [[sourceFile, 'minted-1']], stamped)

    // Assert
    expect(resolved.meta?.source).toBe('DocumentReference/minted-1')
  })
})
