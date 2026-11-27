/**
 * Row text: how a row of Decided automatically names its record and the
 * detail under its name.
 *
 * @packageDocumentation
 */
import { MatchQuery } from '@wildflowerhealthio/fhir-r4/clients'
import { HumanName, type ReferenceType } from '@wildflowerhealthio/fhir-r4/data-types'
import {
  type FhirResource,
  type FhirResourceWithId,
  literalReferenceOf,
  LogicalReference,
} from '@wildflowerhealthio/fhir-r4/resources'
import {
  ImportedCopy,
  ImportedRecord,
  type PlanResolution,
  PlannedRecord,
  type RecordKey,
} from '@wildflowerhealthio/importer-fundamentals'
import { Array as Arr, Data, type DateTime, HashMap, Match, Option } from 'effect'

import { summaryIfDescribed } from './describe-resource.ts'
import * as FieldValueText from './field-value-text.ts'
import { NO_IDENTIFIER, patientDetail, referencePart, referencesDetail } from './plan-text.ts'

/**
 * The line under a row's title: plain `Text`, or an `Identifier`'s value,
 * shown in mono.
 */
type RowDetail = Data.TaggedEnum<{
  Text: { readonly text: string }
  Identifier: { readonly value: string }
}>

const RowDetail = Data.taggedEnum<RowDetail>()

/**
 * The name `resource` goes by in a row: the name a Patient or Practitioner
 * goes by at `now`, else its one-line summary (`summaryIfDescribed`); `None`
 * when it has neither.
 */
const nameIfAny = (now: DateTime.DateTime, resource: FhirResource): Option.Option<string> => {
  const personName =
    resource.resourceType === 'Patient' || resource.resourceType === 'Practitioner'
      ? Option.fromNullable(HumanName.displayName(resource.name, now))
      : Option.none()
  return Option.orElse(personName, () => summaryIfDescribed(resource))
}

/**
 * The name a row lists `planned` under, read off the record as reviewed
 * ({@link nameIfAny}), else the title the plan shows it under
 * (`ImportedRecord.titleOf`).
 */
const rowTitleOf = (now: DateTime.DateTime, planned: PlannedRecord.Type): string =>
  nameIfAny(now, PlannedRecord.reviewedResourceOf(planned)).pipe(
    Option.getOrElse(() => ImportedRecord.titleOf(planned.record))
  )

/**
 * The name a row's option names an existing record by ({@link nameIfAny}),
 * else its literal reference, `<Type>/<id>`.
 */
const existingRecordTitleOf = (now: DateTime.DateTime, existing: FhirResourceWithId): string =>
  nameIfAny(now, existing).pipe(Option.getOrElse(() => literalReferenceOf(existing)))

/** A record of the plan a reference can name: its key, its row title, and whether it is not added. */
interface ReferencedRecord {
  readonly key: RecordKey.Type
  readonly title: string
  readonly isNotAdded: boolean
}

/**
 * Every record of a resolved plan, titled once ({@link rowTitleOf}), by its
 * key and by each spelling a resolved reference can name it by: a literal
 * reference (`<Type>/<id>` where it is written or linked, then each copy's
 * stage literal, which a reference to a record with no choice yet keeps),
 * and each logical reference by a qualified identifier it carries.
 */
interface ReferencedRecords {
  readonly byKey: HashMap.HashMap<RecordKey.Type, ReferencedRecord>
  readonly byLiteral: HashMap.HashMap<string, ReferencedRecord>
  readonly byLogicalReference: HashMap.HashMap<LogicalReference.Key, ReferencedRecord>
}

/** `entries` as a map, the first entry under a key kept. */
const firstKept = <K, V>(entries: readonly (readonly [K, V])[]): HashMap.HashMap<K, V> =>
  HashMap.fromIterable(entries.toReversed())

/** The records of `resolution`, each titled once at `now` ({@link ReferencedRecords}). */
const referencedRecordsOf = (
  now: DateTime.DateTime,
  resolution: PlanResolution.Type
): ReferencedRecords => {
  const records = resolution.records.map((resolved) => ({
    resolved,
    referenced: {
      key: resolved.planned.record.key,
      title: rowTitleOf(now, resolved.planned),
      isNotAdded: resolved.label === 'DontAdd',
    } satisfies ReferencedRecord,
  }))
  return {
    byKey: HashMap.fromIterable(records.map(({ referenced }) => [referenced.key, referenced])),
    byLiteral: firstKept([
      ...records.flatMap(({ resolved, referenced }) =>
        Option.toArray(resolved.id).map(
          (id) =>
            [ImportedRecord.literalReferenceUnder(resolved.planned.record, id), referenced] as const
        )
      ),
      ...records.flatMap(({ resolved, referenced }) =>
        resolved.planned.record.copies.map(
          (copy) => [ImportedCopy.stageLiteralOf(copy), referenced] as const
        )
      ),
    ]),
    byLogicalReference: firstKept(
      records.flatMap(({ resolved, referenced }) => {
        const resource = ImportedRecord.resourceOf(resolved.planned.record)
        return MatchQuery.qualifiedIdentifiersOf(resource).map(
          (identifier) =>
            [
              LogicalReference.key(LogicalReference.make(resource.resourceType, identifier)),
              referenced,
            ] as const
        )
      })
    ),
  }
}

/**
 * The title of the record under `key` ({@link rowTitleOf}), as
 * `referencedRecords` holds it.
 *
 * @throws When it holds no record under `key`, a defect: it holds every
 *   record of the resolution it was built from.
 */
const titleOf = (referencedRecords: ReferencedRecords, key: RecordKey.Type): string =>
  HashMap.get(referencedRecords.byKey, key).pipe(
    Option.map(({ title }) => title),
    Option.getOrThrowWith(() => new Error('Every record of the resolution is titled'))
  )

/** The top-level field a reference at `path` sits in: `performer[0].actor` is in `performer`. */
const topLevelFieldOf = (path: string): string => path.split(/[.[]/u)[0] ?? path

/** What a reference shows: the text, and whether it names nothing a reader could follow. */
interface ReferenceDisplay {
  readonly display: string
  readonly isDisplayOnly: boolean
}

/** What `referenced` shows a reference to it as: its title, display only when it is not added. */
const displayOfRecord = (referenced: ReferencedRecord): ReferenceDisplay => ({
  display: referenced.title,
  isDisplayOnly: referenced.isNotAdded,
})

/**
 * What a resolved `reference` shows: the title of the record of the import
 * it names by literal or identifier, whatever its choice, display only when
 * it is not added; else its own `display`, display only when it names
 * nothing by literal or identifier; else its literal reference. `None` when
 * it has nothing to show.
 */
const referenceDisplayOf = (
  referencedRecords: ReferencedRecords,
  reference: ReferenceType
): Option.Option<ReferenceDisplay> =>
  Option.fromNullable(reference.reference).pipe(
    Option.flatMap((literal) => HashMap.get(referencedRecords.byLiteral, literal)),
    Option.orElse(() =>
      Option.flatMap(LogicalReference.tryFromReference(reference), (logicalReference) =>
        HashMap.get(referencedRecords.byLogicalReference, LogicalReference.key(logicalReference))
      )
    ),
    Option.map(displayOfRecord),
    Option.orElse(() =>
      Option.fromNullable(reference.display).pipe(
        Option.filter((display) => display.trim() !== ''),
        Option.map((display): ReferenceDisplay => ({
          display,
          isDisplayOnly: reference.reference === null && reference.identifier === null,
        }))
      )
    ),
    Option.orElse(() =>
      Option.map(Option.fromNullable(reference.reference), (literal): ReferenceDisplay => ({
        display: literal,
        isDisplayOnly: false,
      }))
    )
  )

/**
 * The detail under a row's title, read off its record as reviewed: a
 * Patient's birthDate and gender ("No birthDate" when it states none); a
 * Practitioner's key identifier (`ImportedRecord.keyIdentifierOf`), in mono
 * ("No identifier" when it has none); any other record's references,
 * resolved, each as `field: display` ({@link referenceDisplayOf}), "No
 * references" when none has anything to show.
 */
const detailOf = (
  now: DateTime.DateTime,
  referencedRecords: ReferencedRecords,
  resolved: PlanResolution.ResolvedRecord
): RowDetail => {
  const resource = PlannedRecord.reviewedResourceOf(resolved.planned)
  const textOf = (field: string): Option.Option<string> =>
    Option.map(FieldValueText.textOf(now, resource, field), ({ text }) => text)
  return Match.value(resource.resourceType).pipe(
    Match.when('Patient', () =>
      RowDetail.Text({
        text: patientDetail({ birthDate: textOf('birthDate'), gender: textOf('gender') }),
      })
    ),
    Match.when('Practitioner', () =>
      Option.match(ImportedRecord.keyIdentifierOf(resolved.planned.record), {
        onNone: () => RowDetail.Text({ text: NO_IDENTIFIER }),
        onSome: ({ value }) => RowDetail.Identifier({ value }),
      })
    ),
    Match.orElse(() =>
      RowDetail.Text({
        text: referencesDetail(
          Arr.filterMap(resolved.resolvedReferences, ({ path, reference }) =>
            Option.map(referenceDisplayOf(referencedRecords, reference), (shown) =>
              referencePart({ field: topLevelFieldOf(path), ...shown })
            )
          )
        ),
      })
    )
  )
}

export { detailOf, existingRecordTitleOf, RowDetail, referencedRecordsOf, rowTitleOf, titleOf }
export type { ReferencedRecord, ReferencedRecords }
