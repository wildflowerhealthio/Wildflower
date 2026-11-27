import { FhirResourceSchema, type FhirResourceWithId } from '@wildflowerhealthio/fhir-r4/resources'
import { type FormatKind, formatKinds } from '@wildflowerhealthio/importer-core'
import {
  Difference,
  FileSetOrigin,
  FormatDecode,
  type ImportedCopy,
  ImportedRecord,
  ImportPlan,
  type PickedFile,
  PlannedRecord,
  RecordChoice,
  StoredMatch,
  Suggestion,
} from '@wildflowerhealthio/importer-fundamentals'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Array as Arr, Option, ParseResult, Schema } from 'effect'
import fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { recordKeyText } from './decision-card-ids.ts'
import * as PlanSections from './plan-sections.ts'
import { batchCopiesOf, reviewedPlanOf, storedOf } from './plan.test-helpers.ts'

/** The types the arbitrary plans' records are of: the two people types and two others. */
const RESOURCE_TYPES = ['Patient', 'Practitioner', 'Observation', 'MedicationRequest'] as const

type ResourceTypeOfRecord = (typeof RESOURCE_TYPES)[number]

/** A record's wire of `resourceType`, told apart by `title`, without an id. */
const wireOf = (resourceType: ResourceTypeOfRecord, title: string): object =>
  ({
    Patient: { resourceType, name: [{ family: title }] },
    Practitioner: { resourceType, name: [{ family: title }] },
    Observation: { resourceType, status: 'final', code: { text: title } },
    MedicationRequest: {
      resourceType,
      status: 'active',
      intent: 'order',
      subject: { display: 'Tyra Banks' },
      medicationCodeableConcept: { text: title },
    },
  })[resourceType]

/**
 * What one arbitrary record is: its type, its file, another file that brings
 * a copy of it first, whether its last copy is implied, its suggestion's
 * reason, and the reviewer's choice.
 */
interface RecordShape {
  readonly resourceType: ResourceTypeOfRecord
  readonly fileName: string
  readonly alsoIn: Option.Option<string>
  readonly isImplied: boolean
  readonly reason: Suggestion.Reason['_tag']
  /** Whether the import gives the record a field its existing record lacks. */
  readonly differs: boolean
  readonly chosen: 'None' | 'SaveAsNewRecord' | 'DontAdd' | 'MergeIntoExisting'
}

const arbitraryShape: fc.Arbitrary<RecordShape> = fc.record({
  resourceType: fc.constantFrom(...RESOURCE_TYPES),
  fileName: fc.constantFrom('a.har', 'b.har', 'c.har'),
  alsoIn: fc
    .option(fc.constantFrom('a.har', 'b.har', 'c.har'), { nil: undefined })
    .map(Option.fromNullable),
  isImplied: fc.boolean(),
  reason: fc.constantFrom(
    'SeveralIdentifierMatches',
    'OneIdentifierMatch',
    'NoMatch',
    'NameMatchReferenced',
    'NameMatchNotReferenced'
  ),
  differs: fc.boolean(),
  chosen: fc.constantFrom('None', 'SaveAsNewRecord', 'DontAdd', 'MergeIntoExisting'),
})

/**
 * The record of the wire `fields` under the stage id `stageId`: a decoded
 * copy from `alsoIn` first, when given, then a copy from `fileName`,
 * implied when `isImplied`.
 */
const recordOf = (
  fields: object,
  stageId: string,
  { fileName, alsoIn, isImplied }: Pick<RecordShape, 'fileName' | 'alsoIn' | 'isImplied'>
): ImportedRecord.Type => {
  const resource: ImportedCopy.Type['resource'] = {
    ...Schema.decodeUnknownSync(FhirResourceSchema)({ id: stageId, ...fields }),
    id: null,
  }
  const copyFrom = (file: string, isImpliedCopy: boolean): ImportedCopy.Type => ({
    origin: {
      format: 'har',
      pickedFiles: [{ id: `0:${file}`, fileName: file, bytes: new Uint8Array() }],
    },
    reviewKey: stageId,
    title: `${resource.resourceType}/${stageId}`,
    isImplied: isImpliedCopy,
    resource,
    sourceUrl: Option.none(),
    stageId: { _tag: 'Minted', id: stageId },
  })
  return Option.getOrThrow(
    Arr.head(
      ImportedRecord.fromCopies([
        ...Option.toArray(Option.map(alsoIn, (file) => copyFrom(file, false))),
        copyFrom(fileName, isImplied),
      ])
    )
  )
}

/**
 * The record of `shape`, the `index`th of its plan: one stored record of
 * its type it could merge into (two for several identifier matches), the
 * suggestion its reason makes, and the reviewer's choice.
 */
const plannedOf = (shape: RecordShape, index: number): PlannedRecord.Type => {
  const title = `record-${index}`
  const existing: FhirResourceWithId = storedOf({
    ...wireOf(shape.resourceType, title),
    id: `s-${index}`,
  })
  const other: FhirResourceWithId = storedOf({
    ...wireOf(shape.resourceType, title),
    id: `t-${index}`,
  })
  const record = recordOf(
    { ...wireOf(shape.resourceType, title), ...(shape.differs ? { language: 'en' } : {}) },
    `stage-${index}`,
    shape
  )
  const found = (resource: FhirResourceWithId) =>
    ({ resource, grade: 'certain', by: 'identifier' }) as const
  const linkExisting = RecordChoice.mergeTakingNoField(existing)
  const { candidates, suggestion } = {
    SeveralIdentifierMatches: {
      candidates: [found(existing), found(other)],
      suggestion: Suggestion.make(Option.none(), Suggestion.SeveralIdentifierMatches()),
    },
    OneIdentifierMatch: {
      candidates: [found(existing)],
      suggestion: Suggestion.make(
        Option.some(
          RecordChoice.mergeFillingGaps(
            existing,
            shape.differs ? [Difference.FillsGap({ field: 'language' })] : []
          )
        ),
        Suggestion.OneIdentifierMatch()
      ),
    },
    NoMatch: {
      candidates: [],
      suggestion: Suggestion.make(
        Option.some(RecordChoice.SaveAsNewRecord()),
        Suggestion.NoMatch()
      ),
    },
    NameMatchReferenced: {
      candidates: [found(existing)],
      suggestion: Suggestion.make(Option.some(linkExisting), Suggestion.NameMatchReferenced()),
    },
    NameMatchNotReferenced: {
      candidates: [found(existing)],
      suggestion: Suggestion.make(
        Option.some(RecordChoice.SaveAsNewRecord()),
        Suggestion.NameMatchNotReferenced()
      ),
    },
  }[shape.reason]
  const planned = PlannedRecord.make({
    record,
    storedMatch: StoredMatch.makeEntry(candidates, Option.none()),
    suggestion,
  })
  const chosen = {
    None: Option.none(),
    SaveAsNewRecord: Option.some(RecordChoice.SaveAsNewRecord()),
    DontAdd: Option.some(RecordChoice.DontAdd()),
    MergeIntoExisting: Option.some(linkExisting),
  }[shape.chosen]
  return Option.match(chosen, {
    onNone: () => planned,
    onSome: (choice) => PlannedRecord.withChoice(planned, choice),
  })
}

/** The plan of `shapes`, in order. */
const planOf = (shapes: readonly RecordShape[]): ImportPlan.Type =>
  ImportPlan.make(shapes.map(plannedOf), StoredMatch.empty)

/** Every group of `sections`. */
const groupsIn = (sections: readonly PlanSections.Section[]): readonly PlanSections.Group[] =>
  sections.flatMap(({ groups }) => groups)

/** The key of a row's record as text. */
const keyTextOf = (row: PlanSections.Row): string => recordKeyText(row.resolved.planned.record.key)

const arbitraryPlan = fc.array(arbitraryShape, { maxLength: 24 }).map(planOf)

describe('PlanSections.sectionsOf', () => {
  it('lists every record that needs no decision in exactly one group, and none that needs one', () => {
    fc.assert(
      fc.property(arbitraryPlan, (plan) => {
        const rows = groupsIn(PlanSections.sectionsOf(reviewedPlanOf(plan))).flatMap(
          PlanSections.rowsOfGroup
        )
        expect(rows.map(keyTextOf).toSorted()).toEqual(
          plan.records
            .filter((planned) => !PlannedRecord.needsDecision(planned))
            .map(({ record }) => recordKeyText(record.key))
            .toSorted()
        )
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('holds exactly the Patients and Practitioners in the people’s section, first, and one section per file set after it', () => {
    fc.assert(
      fc.property(arbitraryPlan, (plan) => {
        const sections = PlanSections.sectionsOf(reviewedPlanOf(plan))
        const [people, fileSets] = Arr.partition(sections, ({ _tag }) => _tag === 'FileSet')
        expect(sections.slice(0, people.length)).toEqual(people)
        expect(
          people.flatMap(({ groups }) => groups.map(({ resourceType }) => resourceType))
        ).toEqual(
          ['Patient', 'Practitioner'].filter((type) =>
            plan.records.some(
              (planned) =>
                !PlannedRecord.needsDecision(planned) &&
                ImportedRecord.resourceTypeOf(planned.record) === type
            )
          )
        )
        for (const section of fileSets) {
          if (section._tag !== 'FileSet') continue
          for (const row of section.groups.flatMap(PlanSections.rowsOfGroup)) {
            expect(['Patient', 'Practitioner']).not.toContain(
              ImportedRecord.resourceTypeOf(row.resolved.planned.record)
            )
            expect(
              FileSetOrigin.equivalence(
                ImportedRecord.originOf(row.resolved.planned.record),
                section.origin
              )
            ).toBe(true)
          }
        }
        const origins = fileSets.flatMap((section) =>
          section._tag === 'FileSet' ? [section.origin] : []
        )
        expect(Arr.dedupeWith(origins, FileSetOrigin.equivalence)).toEqual(origins)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('lists changed rows first, and folds exactly the unchanged identifier matches with nothing to merge', () => {
    fc.assert(
      fc.property(fc.array(arbitraryShape, { maxLength: 24 }), (shapes) => {
        const plan = planOf(shapes)
        const groups = groupsIn(PlanSections.sectionsOf(reviewedPlanOf(plan)))
        for (const { listed } of groups) {
          const changed = listed.map(PlanSections.isChanged)
          expect(changed).toEqual(changed.toSorted((left, right) => Number(right) - Number(left)))
        }
        const shapeOf = (row: PlanSections.Row): RecordShape | undefined =>
          shapes[Number(keyTextOf(row).split('stage-')[1])]
        const isFoldedShape = (shape: RecordShape | undefined): boolean =>
          shape?.reason === 'OneIdentifierMatch' &&
          !shape.differs &&
          (shape.chosen === 'None' || shape.chosen === 'MergeIntoExisting')
        expect(
          groups
            .flatMap(({ folded }) => folded)
            .map(shapeOf)
            .every(isFoldedShape)
        ).toBe(true)
        expect(
          groups
            .flatMap(({ listed }) => listed)
            .map(shapeOf)
            .some(isFoldedShape)
        ).toBe(false)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('lists a group’s changed rows first, each part by label, updated, new, not added, then linked, and in plan order among equals', () => {
    // Arrange
    const shape = (
      reason: Suggestion.Reason['_tag'],
      chosen: RecordShape['chosen'],
      differs = false
    ): RecordShape => ({
      resourceType: 'Observation',
      fileName: 'a.har',
      alsoIn: Option.none(),
      isImplied: false,
      reason,
      differs,
      chosen,
    })
    const plan = planOf([
      shape('OneIdentifierMatch', 'None', true),
      shape('NoMatch', 'None'),
      shape('NameMatchNotReferenced', 'None'),
      shape('NoMatch', 'DontAdd'),
      shape('NoMatch', 'None'),
      shape('OneIdentifierMatch', 'MergeIntoExisting', true),
    ])

    // Act
    const [group] = groupsIn(PlanSections.sectionsOf(reviewedPlanOf(plan)))

    // Assert — the changed rows first, not added before linked; then the
    // update before the new records
    expect(
      group?.listed.map((row) => [
        Number(keyTextOf(row).split('stage-')[1]),
        row.label,
        PlanSections.isChanged(row),
      ])
    ).toEqual([
      [3, 'DontAdd', true],
      [5, 'LinkToExisting', true],
      [0, 'Update', false],
      [1, 'Create', false],
      [2, 'Create', false],
      [4, 'Create', false],
    ])
  })
})

describe('PlanSections.sectionsOf, a file set’s notes and settings', () => {
  /** A picked file of `fileName` at batch position `position`. */
  const pickedFile = (position: number, fileName: string): PickedFile.Type => ({
    id: `${position}:${fileName}`,
    fileName,
    bytes: new Uint8Array(),
  })

  /** An Observation of `file`, read by `format`, the plan's suggestion for it a decision or a new record. */
  const observationOf = (
    format: FormatKind,
    file: PickedFile.Type,
    reason: 'NameMatchReferenced' | 'NoMatch'
  ): PlannedRecord.Type => {
    const copy: ImportedCopy.Type = {
      origin: FileSetOrigin.fromPickedFiles(format, [file]),
      reviewKey: `${file.id}/observation`,
      title: `Observation of ${file.fileName}`,
      isImplied: false,
      resource: {
        ...Schema.decodeUnknownSync(FhirResourceSchema)({
          ...wireOf('Observation', file.fileName),
          id: 'stage',
        }),
        id: null,
      },
      sourceUrl: Option.none(),
      stageId: { _tag: 'Minted', id: `stage-${file.id}` },
    }
    return PlannedRecord.make({
      record: Option.getOrThrow(Arr.head(ImportedRecord.fromCopies([copy]))),
      storedMatch: StoredMatch.makeEntry([], Option.none()),
      suggestion:
        reason === 'NoMatch'
          ? Suggestion.make(Option.some(RecordChoice.SaveAsNewRecord()), Suggestion.NoMatch())
          : Suggestion.make(Option.none(), Suggestion.NameMatchReferenced()),
    })
  }

  const withRow = pickedFile(0, 'with-row.har')
  const withNotes = pickedFile(1, 'with-notes.har')
  const withNothing = pickedFile(2, 'with-nothing.har')
  const report = pickedFile(3, 'report.pdf')
  const unreadableReport = pickedFile(4, 'unreadable.pdf')
  const unreadableHar = pickedFile(5, 'unreadable.har')

  /**
   * A HAR with a row, one whose only record needs a decision but whose
   * decode noted something, one whose only record needs a decision, one
   * unreadable; a LifeLabs report whose only record needs a decision, and
   * one unreadable.
   */
  const review = (): PlanSections.ReviewedPlan => {
    const plan = ImportPlan.make(
      [
        observationOf('har', withRow, 'NoMatch'),
        observationOf('har', withNotes, 'NameMatchReferenced'),
        observationOf('har', withNothing, 'NameMatchReferenced'),
        observationOf('lifelabs-pdf', report, 'NameMatchReferenced'),
      ],
      StoredMatch.empty
    )
    const reviewed = reviewedPlanOf(plan)
    const [har, lifeLabs] = batchCopiesOf(plan).formats
    if (har === undefined || lifeLabs === undefined) throw new Error('Two formats are read')
    const unreadable = (format: FormatKind, file: PickedFile.Type): FormatDecode.UnreadableFile =>
      FormatDecode.makeUnreadableFile(
        format,
        file,
        new ParseResult.ParseError({
          issue: new ParseResult.Type(Schema.Unknown.ast, file.fileName, 'rejected'),
        })
      )
    return {
      ...reviewed,
      batchCopies: {
        formats: [
          {
            ...har,
            files: [...har.files, unreadableHar],
            notes: [
              {
                origin: FileSetOrigin.fromPickedFiles('har', [withNotes]),
                notes: ['Matched no importer: https://example.test/a'],
              },
            ],
            unreadableFiles: [unreadable('har', unreadableHar)],
          },
          {
            ...lifeLabs,
            files: [unreadableReport, ...lifeLabs.files],
            unreadableFiles: [unreadable('lifelabs-pdf', unreadableReport)],
          },
        ],
        unrecognizedFiles: [],
      },
    }
  }

  it('gives a file set a section when it has a row, when its decode noted something, or when its format has settings, unreadable files of such a format included, in the order of their files', () => {
    // Arrange / Act
    const sections = PlanSections.sectionsOf(review())

    // Assert
    expect(
      sections.map((section) =>
        section._tag === 'FileSet'
          ? {
              files: section.origin.pickedFiles.map(({ fileName }) => fileName),
              format: section.format,
              groups: section.groups.map(({ resourceType }) => resourceType),
              notes: section.notes,
              formatFileSets: section.formatFileSets,
            }
          : section._tag
      )
    ).toEqual([
      {
        files: ['with-row.har'],
        format: 'har',
        groups: ['Observation'],
        notes: [],
        formatFileSets: 3,
      },
      {
        files: ['with-notes.har'],
        format: 'har',
        groups: [],
        notes: ['Matched no importer: https://example.test/a'],
        formatFileSets: 3,
      },
      {
        files: ['unreadable.pdf'],
        format: 'lifelabs-pdf',
        groups: [],
        notes: [],
        formatFileSets: 2,
      },
      { files: ['report.pdf'], format: 'lifelabs-pdf', groups: [], notes: [], formatFileSets: 2 },
    ])
  })

  it('says only a format with a settings picker has settings', () => {
    expect(formatKinds.map((format) => [format, PlanSections.hasSettings(format)])).toEqual([
      ['har', false],
      ['lifelabs-pdf', true],
      ['dicom', true],
    ])
  })
})

describe('PlanSections.listedPageOf', () => {
  /** A group of `count` new Observations. */
  const groupOf = (count: number): PlanSections.Group =>
    Option.getOrThrow(
      Arr.head(
        groupsIn(
          PlanSections.sectionsOf(
            reviewedPlanOf(
              planOf(
                Arr.makeBy(count, () => ({
                  resourceType: 'Observation',
                  fileName: 'a.har',
                  alsoIn: Option.none(),
                  isImplied: false,
                  reason: 'NoMatch',
                  differs: false,
                  chosen: 'None',
                }))
              )
            )
          )
        )
      )
    )

  it('shows the first page, then twenty more on each Show more, then none', () => {
    // Arrange
    const group = groupOf(30)

    // Act
    const pages = [6, 26, 46].map((shown) => PlanSections.listedPageOf(group, shown))

    // Assert
    expect(pages.map(({ rows, more }) => [rows.length, more])).toEqual([
      [6, 20],
      [26, 4],
      [30, 0],
    ])
    expect(pages[0]?.rows).toEqual(group.listed.slice(0, 6))
  })
})
