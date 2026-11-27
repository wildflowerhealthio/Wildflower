/**
 * Plan sections: the records of an import plan that need no decision, as
 * the Decided automatically section lists them: the people first, then one
 * section per file set, each in groups by FHIR resource type, with what the
 * set's decode noted.
 *
 * @packageDocumentation
 */
import type { FormatCopies, FormatKind } from '@wildflowerhealthio/importer-core'
import {
  type Difference,
  FileSetOrigin,
  FormatDecode,
  ImportedRecord,
  type PlanResolution,
  PlanTotals,
  PlannedRecord,
  RecordChoice,
  type RecordKey,
  RecordReferences,
} from '@wildflowerhealthio/importer-fundamentals'
import { groupInOrder } from '@wildflowerhealthio/kitchen-sink'
import { Array as Arr, Data, HashMap, Number as Num, Option, Order } from 'effect'

import { formatRegistry } from '../registry.ts'
import * as PlanDifferences from './plan-differences.ts'
import { personReasonLine, recordReasonLine } from './plan-text.ts'
import * as ReasonTag from './reason-tag.ts'
import * as RecordText from './record-text.ts'
import * as RowText from './row-text.ts'
import type { Review } from './use-import-plan-page.ts'

/**
 * One record decided automatically, as its row shows it.
 *
 * @remarks
 * `reason` and `suggestedDifferences` are the suggestion's, whatever the
 * reviewer chose since: `suggestedDifferences` is what merging into the
 * existing record the suggestion merges into would change, given the plan's
 * choices, and none when the suggestion merges into none.
 */
interface Row {
  readonly resolved: PlanResolution.ResolvedRecord
  /** How the plan counts it (`resolved.label`), never `Open`: a record decided automatically always has a choice. */
  readonly label: RowLabel
  readonly reason: ReasonTag.DecidedReason
  readonly suggestedDifferences: readonly Difference.Type[]
  /** The name the row lists the record under (`RowText.rowTitleOf`). */
  readonly title: string
  readonly detail: RowText.RowDetail
  /** How many records of the import reference it. */
  readonly referrers: number
  /** The existing records it could merge into, each with the title its option names it by. */
  readonly candidates: readonly RowCandidate[]
}

/** How the plan counts a record decided automatically: any label but `Open`. */
type RowLabel = Exclude<PlanResolution.Label, 'Open'>

/** An existing record a row's record could merge into, and its title (`RowText.existingRecordTitleOf`). */
interface RowCandidate {
  readonly candidate: PlanDifferences.Candidate
  readonly title: string
}

/**
 * The rows of one FHIR resource type in a section: the `listed` rows, in row
 * order ({@link rowOrder}), then the rows `folded` away as the same as
 * existing records ({@link isSameAsExisting}), in plan order.
 */
interface Group {
  readonly resourceType: string
  readonly listed: readonly Row[]
  readonly folded: readonly Row[]
  /** How many of its records carry each label, which its status line says. */
  readonly counts: PlanTotals.Counts
}

/**
 * A section of Decided automatically: the `People` (Patient and
 * Practitioner, whichever file set brought them), or one file set
 * (`FileSet`, by its `origin`): the other records it brought, in groups by
 * type, and what its decode noted.
 */
type Section = Data.TaggedEnum<{
  People: { readonly groups: readonly Group[] }
  FileSet: {
    readonly origin: FileSetOrigin.Type
    /** The registered format that read it: `origin`'s. */
    readonly format: FormatKind
    readonly groups: readonly Group[]
    /** What its decode noted, in the order noted. */
    readonly notes: readonly string[]
    /** How many file sets of its format the import holds, its own included: its format's settings are each one's. */
    readonly formatFileSets: number
  }
}>

const Section = Data.taggedEnum<Section>()

/** The types the people's section holds, in the order it lists them. */
const PEOPLE_TYPES: readonly string[] = ['Patient', 'Practitioner']

/** How many listed rows a group shows before its first "Show more". */
const FIRST_PAGE_SIZE = 6

/** How many more listed rows each "Show more" shows. */
const PAGE_SIZE = 20

/** The record a row shows, as planned. */
const plannedOf = (row: Row): PlannedRecord.Type => row.resolved.planned

/** Whether the reviewer chose something other than the row's suggestion (`PlannedRecord.isChanged`). */
const isChanged = (row: Row): boolean => PlannedRecord.isChanged(plannedOf(row))

/**
 * Whether a row is the same as an existing record: suggested for one
 * identifier match, no differences from the record it merges into, linked
 * to it, and not changed by the reviewer.
 */
const isSameAsExisting = (row: Row): boolean =>
  row.reason._tag === 'OneIdentifierMatch' &&
  row.suggestedDifferences.length === 0 &&
  row.label === 'LinkToExisting' &&
  !isChanged(row)

/** Where a label sorts among a group's listed rows: Update, Create, then not added or needed, then linked. */
const LABEL_RANK: { readonly [Label in RowLabel]: number } = {
  Update: 1,
  Create: 2,
  DontAdd: 3,
  Unneeded: 3,
  LinkToExisting: 4,
}

/**
 * The order of a group's listed rows: the rows the reviewer changed first,
 * then by label ({@link LABEL_RANK}); a stable sort keeps plan order among
 * equals.
 */
const rowOrder: Order.Order<Row> = Order.combine(
  Order.mapInput(Order.reverse(Order.boolean), isChanged),
  Order.mapInput(Order.number, (row: Row) => LABEL_RANK[row.label])
)

/** The group of `rows`, all of `resourceType`, in plan order: listed in {@link rowOrder}, the same as existing folded. */
const groupOf = (resourceType: string, rows: readonly Row[]): Group => {
  const [listed, folded] = Arr.partition(rows, isSameAsExisting)
  return {
    resourceType,
    listed: Arr.sort(listed, rowOrder),
    folded,
    counts: PlanTotals.makeCounts((label) => rows.filter((row) => row.label === label).length, 0),
  }
}

/** The resource type of the record a row shows. */
const resourceTypeOf = (row: Row): string => ImportedRecord.resourceTypeOf(plannedOf(row).record)

/** The differences of the merge `planned`'s suggestion makes, given the plan's choices; none when it merges into none. */
const suggestedDifferencesOf = (
  differences: PlanDifferences.Type,
  planned: PlannedRecord.Type
): readonly Difference.Type[] =>
  planned.suggestion.choice.pipe(
    Option.filter(RecordChoice.is('MergeIntoExistingRecord')),
    Option.flatMap(({ existing }) =>
      PlanDifferences.candidateOf(differences, planned.record.key, existing)
    ),
    Option.map(({ inPlan }) => inPlan.differences),
    Option.getOrElse((): readonly Difference.Type[] => [])
  )

/**
 * What the sections are read from: a review's files as read, its
 * resolution, differences and record references, and when it was read.
 */
type ReviewedPlan = Pick<
  Review,
  'batchCopies' | 'resolution' | 'differences' | 'recordReferences' | 'readAt'
>

/**
 * `label` as a row's.
 *
 * @throws When it is `Open`, a defect: a record decided automatically is
 *   suggested a choice for each of its reasons.
 */
const rowLabelOf = (label: PlanResolution.Label): RowLabel => {
  if (label === 'Open') throw new Error('A record decided automatically has no choice')
  return label
}

/**
 * Every record of `review` that needs no decision, as its row, in plan
 * order, each record and each existing record titled once.
 */
const rowsOf = (review: ReviewedPlan): readonly Row[] => {
  const referencedRecords = RowText.referencedRecordsOf(review.readAt, review.resolution)
  return Arr.filterMap(review.resolution.records, (resolved) => {
    const { key } = resolved.planned.record
    return Option.map(
      ReasonTag.decidedReasonOf(resolved.planned.suggestion.reason),
      (reason): Row => ({
        resolved,
        label: rowLabelOf(resolved.label),
        reason,
        suggestedDifferences: suggestedDifferencesOf(review.differences, resolved.planned),
        title: RowText.titleOf(referencedRecords, key),
        detail: RowText.detailOf(review.readAt, referencedRecords, resolved),
        referrers: RecordReferences.referrersOf(review.recordReferences, key).length,
        candidates: PlanDifferences.candidatesOf(review.differences, key).map((candidate) => ({
          candidate,
          title: RowText.existingRecordTitleOf(review.readAt, candidate.existing),
        })),
      })
    )
  })
}

/** Whether a row shows a Patient or a Practitioner. */
const isPerson = (row: Row): boolean => PEOPLE_TYPES.includes(resourceTypeOf(row))

/** A file set's id over its format and its files (`FormatDecode.makeId`). */
const idOfOrigin = ({ format, pickedFiles }: FileSetOrigin.Type): string =>
  FormatDecode.makeId(format, pickedFiles)

/** The file set a row's record is listed under, by its id. */
const fileSetIdOf = (row: Row): string => idOfOrigin(ImportedRecord.originOf(plannedOf(row).record))

/** Whether `format` has settings a reviewer can change: a settings picker in the registry. */
const hasSettings = (format: FormatKind): boolean =>
  formatRegistry[format].SettingsPicker !== undefined

/**
 * Every file set of one format's read, in the order of its first picked
 * file among the files the format claimed: each set the import stage
 * finished, and, when the format has settings, each file it could not read
 * as a set of its own, since a setting may be why and its settings are
 * where that is put right.
 */
const fileSetsOfFormat = (
  formatCopies: FormatCopies<FormatKind>
): readonly FileSetOrigin.Type[] => {
  const finished = groupInOrder(formatCopies.copies, ({ origin }) => idOfOrigin(origin)).map(
    ({ items }) => Arr.headNonEmpty(items).origin
  )
  const unreadable = hasSettings(formatCopies.format)
    ? formatCopies.unreadableFiles.map(({ pickedFile }) =>
        FileSetOrigin.fromPickedFiles(formatCopies.format, [pickedFile])
      )
    : []
  const positionOf = (origin: FileSetOrigin.Type): number =>
    formatCopies.files.findIndex(({ id }) => id === Arr.headNonEmpty(origin.pickedFiles).id)
  return Arr.sort(
    Arr.dedupeWith([...finished, ...unreadable], FileSetOrigin.equivalence),
    Order.mapInput(Order.number, positionOf)
  )
}

/**
 * The sections of Decided automatically, from `review`: every record that
 * needs no decision (`PlannedRecord.needsDecision` false), each in exactly
 * one group.
 *
 * @remarks
 * The people come first, one group per type of {@link PEOPLE_TYPES} that
 * has one, wherever they come from, and only when there is one. Then one
 * section per file set as the files were read: format by format in registry
 * order, each format's sets in the order of their first picked files
 * ({@link fileSetsOfFormat}), so a section keeps its place when a format is
 * read again. A set's records are in groups by type in the order the types
 * first come; a record several file sets bring is listed under its record
 * copy's (`ImportedRecord.originOf`). A set has a section when it has a
 * record, when its decode noted something, or when its format has settings,
 * so its notes and its settings have a home.
 */
const sectionsOf = (review: ReviewedPlan): readonly Section[] => {
  const [others, people] = Arr.partition(rowsOf(review), isPerson)
  const peopleGroups = Arr.sort(
    groupInOrder(people, resourceTypeOf).map(({ key, items }) => groupOf(key, items)),
    Order.mapInput(Order.number, ({ resourceType }: Group) => PEOPLE_TYPES.indexOf(resourceType))
  )
  const rowsByFileSet = HashMap.fromIterable(
    groupInOrder(others, fileSetIdOf).map(({ key, items }) => [key, items] as const)
  )
  const notesByFileSet = HashMap.fromIterable(
    review.batchCopies.formats.flatMap(({ notes }) =>
      notes.map(({ origin, notes: noted }) => [idOfOrigin(origin), noted] as const)
    )
  )
  const fileSetSections = review.batchCopies.formats.flatMap((formatCopies) => {
    const origins = fileSetsOfFormat(formatCopies)
    return Arr.filterMap(origins, (origin) => {
      const id = idOfOrigin(origin)
      const rows = HashMap.get(rowsByFileSet, id).pipe(Option.getOrElse((): readonly Row[] => []))
      const notes = HashMap.get(notesByFileSet, id).pipe(
        Option.getOrElse((): readonly string[] => [])
      )
      const hasSomethingToShow =
        rows.length > 0 || notes.length > 0 || hasSettings(formatCopies.format)
      return Option.liftPredicate(
        Section.FileSet({
          origin,
          format: formatCopies.format,
          groups: Arr.map(groupInOrder(rows, resourceTypeOf), ({ key, items }) =>
            groupOf(key, items)
          ),
          notes,
          formatFileSets: origins.length,
        }),
        () => hasSomethingToShow
      )
    })
  })
  return [
    ...(peopleGroups.length === 0 ? [] : [Section.People({ groups: peopleGroups })]),
    ...fileSetSections,
  ]
}

/** The groups of `section`. */
const groupsOf = (section: Section): readonly Group[] => section.groups

/** Every row of `group`, listed then folded. */
const rowsOfGroup = (group: Group): readonly Row[] => [...group.listed, ...group.folded]

/** How many records `sections` hold. */
const recordCountOf = (sections: readonly Section[]): number =>
  Num.sumAll(sections.flatMap(groupsOf).map((group) => rowsOfGroup(group).length))

/** The key of every record of `group`, folded ones included: what its menu acts on. */
const keysOf = (group: Group): readonly RecordKey.Type[] =>
  rowsOfGroup(group).map((row) => plannedOf(row).record.key)

/**
 * A row's last line in a section `sectionTag` names: its reason tag
 * (`ReasonTag.reasonTagOf`), for a person also its file and how many records
 * reference it, then whether it is not needed.
 */
const reasonLineOf = (sectionTag: Section['_tag'], row: Row): string => {
  const tag = ReasonTag.reasonTagOf(row.reason, row.suggestedDifferences, row.label)
  const isUnneeded = row.label === 'Unneeded'
  return sectionTag === 'People'
    ? personReasonLine({
        fileTitle: RecordText.fileTitleOf(plannedOf(row).record),
        tag,
        referrers: row.referrers,
        isUnneeded,
      })
    : recordReasonLine({ tag, isUnneeded })
}

/** The listed rows a group shows, and how many more its next "Show more" adds; 0 when none is left. */
interface ListedPage {
  readonly rows: readonly Row[]
  readonly more: number
}

/** The first `shown` of `group`'s listed rows, and how many more the next page adds ({@link PAGE_SIZE} at most). */
const listedPageOf = (group: Group, shown: number): ListedPage => ({
  rows: group.listed.slice(0, shown),
  more: Math.min(PAGE_SIZE, Math.max(0, group.listed.length - shown)),
})

export {
  FIRST_PAGE_SIZE,
  hasSettings,
  isChanged,
  isSameAsExisting,
  keysOf,
  listedPageOf,
  PAGE_SIZE,
  recordCountOf,
  reasonLineOf,
  rowOrder,
  rowsOfGroup,
  Section,
  sectionsOf,
}
export type { Group, ListedPage, ReviewedPlan, Row, RowCandidate, RowLabel }
