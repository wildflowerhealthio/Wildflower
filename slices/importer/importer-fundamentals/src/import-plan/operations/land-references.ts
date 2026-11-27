/**
 * Land references: where a reference to each record of an import plan lands
 * for the record's choice, and what a stub to a record not added shows.
 *
 * @packageDocumentation
 */
import { HumanName } from '@wildflowerhealthio/fhir-r4/data-types'
import { type LogicalReference, literalReferenceOf } from '@wildflowerhealthio/fhir-r4/resources'
import { onlyElement } from '@wildflowerhealthio/kitchen-sink'
import { Array as Arr, type DateTime, HashMap, Match, Option } from 'effect'

import type * as ImportPlan from '../entities/import-plan.ts'
import * as ImportedCopy from '../entities/imported-copy.ts'
import * as ImportedRecord from '../entities/imported-record.ts'
import * as PlannedRecord from '../entities/planned-record.ts'
import type * as RecordKey from '../entities/record-key.ts'
import type * as RecordReferences from '../entities/record-references.ts'
import * as ReferenceTable from '../entities/reference-table.ts'
import * as StoredMatch from '../entities/stored-match.ts'
import { locateReferences } from './locate-references.ts'

/**
 * The name a Patient or a Practitioner goes by at `now`
 * (`HumanName.displayName`); `None` for any other record, or a person with
 * no name.
 */
const personNameOf = (
  now: DateTime.DateTime,
  record: ImportedRecord.Type
): Option.Option<string> => {
  const resource = ImportedRecord.resourceOf(record)
  return resource.resourceType === 'Patient' || resource.resourceType === 'Practitioner'
    ? Option.fromNullable(HumanName.displayName(resource.name, now))
    : Option.none()
}

/**
 * The record's title (`ImportedRecord.titleOf`) when it has no key
 * identifier; `None` when it has one, since the title of a record keyed by
 * identifier is the literal it would be written under, and a record not
 * added is never written there.
 */
const keylessTitleOf = (record: ImportedRecord.Type): Option.Option<string> =>
  Option.liftPredicate(ImportedRecord.titleOf(record), () =>
    Option.isNone(ImportedRecord.keyIdentifierOf(record))
  )

/**
 * What a stub to `record` shows when the reference has no `display` of its
 * own: a person's name ({@link personNameOf}), else, for a record with no
 * key identifier, its title ({@link keylessTitleOf}), so a stub that has no
 * identifier to name the record by still shows what it was; `None`
 * otherwise.
 */
const stubDisplayOf = (
  now: DateTime.DateTime,
  record: ImportedRecord.Type
): Option.Option<string> => Option.orElse(personNameOf(now, record), () => keylessTitleOf(record))

/**
 * Where a reference to `planned` lands, by its effective choice: a literal
 * to it under its id when it is written or linked (save as new, merge into
 * existing), a stub when it is not added, nothing when it has no choice.
 */
const targetOf = (
  now: DateTime.DateTime,
  ids: HashMap.HashMap<RecordKey.Type, string>,
  planned: PlannedRecord.Type
): Option.Option<ReferenceTable.Target> =>
  Option.flatMap(
    PlannedRecord.effectiveChoice(planned),
    (choice): Option.Option<ReferenceTable.Target> =>
      Match.value(choice).pipe(
        Match.tag('DontAdd', () =>
          Option.some(
            ReferenceTable.Stub({
              resourceType: ImportedRecord.resourceTypeOf(planned.record),
              keyIdentifier: ImportedRecord.keyIdentifierOf(planned.record),
              display: stubDisplayOf(now, planned.record),
            })
          )
        ),
        Match.orElse(() =>
          Option.map(HashMap.get(ids, planned.record.key), (id) =>
            ReferenceTable.Literal({
              literalReference: ImportedRecord.literalReferenceUnder(planned.record, id),
            })
          )
        )
      )
  )

/** A record of the plan beside the target a reference to it lands on. */
interface RecordTarget {
  readonly record: ImportedRecord.Type
  readonly target: ReferenceTable.Target
}

/** A logical reference beside the target it lands on. */
interface LogicalReferenceTarget {
  readonly logicalReference: LogicalReference.Type
  readonly target: ReferenceTable.Target
}

/**
 * The target of each logical reference naming a record of the import
 * (`RecordReferences.Type`'s `named`): where that record lands.
 */
const namedTargetsOf = (
  recordReferences: RecordReferences.Type,
  recordTargets: readonly RecordTarget[]
): readonly LogicalReferenceTarget[] => {
  const targetsByKey = HashMap.fromIterable(
    recordTargets.map(({ record, target }) => [record.key, target] as const)
  )
  return Arr.filterMap(recordReferences.named, ({ logicalReference, key }) =>
    Option.map(HashMap.get(targetsByKey, key), (target) => ({ logicalReference, target }))
  )
}

/**
 * The target of each external reference (`RecordReferences.Type`'s
 * `external`): a literal to the one stored copy of the record it names
 * (`StoredMatch.storedCopiesOfReference`), none when there are several or
 * none.
 */
const externalTargetsOf = (
  recordReferences: RecordReferences.Type,
  storedMatch: StoredMatch.Type
): readonly LogicalReferenceTarget[] =>
  Arr.filterMap(recordReferences.external, (externalReference) =>
    Option.map(
      onlyElement(StoredMatch.storedCopiesOfReference(storedMatch, externalReference)),
      (stored) => ({
        logicalReference: externalReference,
        target: ReferenceTable.Literal({ literalReference: literalReferenceOf(stored) }),
      })
    )
  )

/**
 * Where a reference to each record of `plan` lands, as a reference table.
 *
 * @param now - The instant the name a stub shows a person by is judged at
 * @param plan - The plan, its choices made
 * @param ids - The id each record that is written or linked is written under
 *   or links to
 *
 * @remarks
 * Each record's target ({@link targetOf}) is where a reference names it by:
 * - a logical reference naming it, alone of the import's records;
 * - the literal the import stage wrote it under (its stage literal), as a
 *   format's hooks and `meta.source` name it;
 * - the URL a source served it at, which an `Attachment.url` or a literal
 *   spells, for a record a source served (a `Binary`); a record not added
 *   keeps the source's URL.
 *
 * An external reference lands on the one stored record found for it by
 * identifier.
 */
const landReferences = (
  now: DateTime.DateTime,
  plan: ImportPlan.Type,
  ids: HashMap.HashMap<RecordKey.Type, string>
): ReferenceTable.Type => {
  const recordTargets = Arr.filterMap(plan.records, (planned) =>
    Option.map(targetOf(now, ids, planned), (target): RecordTarget => ({
      record: planned.record,
      target,
    }))
  )
  const recordReferences = locateReferences(plan.records.map(({ record }) => record))
  return ReferenceTable.make({
    logicalReferences: [
      ...namedTargetsOf(recordReferences, recordTargets),
      ...externalTargetsOf(recordReferences, plan.storedMatch),
    ],
    stageLiterals: recordTargets.flatMap(({ record, target }) =>
      record.copies.map((copy) => ({ stageLiteral: ImportedCopy.stageLiteralOf(copy), target }))
    ),
    sourceUrls: Arr.filterMap(recordTargets, ({ record, target }) =>
      Option.map(ImportedRecord.sourceUrlOf(record), (sourceUrl) => ({ sourceUrl, target }))
    ),
  })
}

export { landReferences }
