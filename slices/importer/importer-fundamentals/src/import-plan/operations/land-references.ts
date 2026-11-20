/**
 * Land references: where a reference to each record of an import plan lands
 * for the record's choice, and what a stub to a record not added shows.
 *
 * @packageDocumentation
 */
import {
  type LogicalReference,
  literalReferenceOf,
  PersonName,
} from '@wildflowerhealthio/fhir-r4/resources'
import { onlyElement } from '@wildflowerhealthio/kitchen-sink'
import { Array as Arr, Effect, HashMap, Match, Option, pipe } from 'effect'

import type * as ImportPlan from '../entities/import-plan.ts'
import * as ImportedRecord from '../entities/imported-record.ts'
import * as PlannedRecord from '../entities/planned-record.ts'
import type * as RecordKey from '../entities/record-key.ts'
import * as RecordReferences from '../entities/record-references.ts'
import * as ReferenceTable from '../entities/reference-table.ts'
import * as StoredMatch from '../entities/stored-match.ts'

/**
 * What a stub to `record` shows when the reference has no `display` of its
 * own: the person's name for a Patient or a Practitioner
 * (`PersonName.maybeDisplayName`, read at the clock's now); `None` for any
 * other record, or a person with no name. Never the record's title: a keyed
 * record's title is the literal it would be written under, and a record not
 * added is never written there.
 */
const stubDisplayOf = (record: ImportedRecord.Type): Effect.Effect<Option.Option<string>> =>
  PersonName.maybeDisplayName(ImportedRecord.resourceOf(record))

/**
 * Where a reference to `planned` lands, by its effective choice: a literal
 * to it under its id when it is written or linked (save as new, use
 * existing), a stub when it is not added, nothing when it has no choice.
 */
const targetOf = (
  planned: PlannedRecord.Type,
  ids: HashMap.HashMap<RecordKey.Type, string>
): Effect.Effect<Option.Option<ReferenceTable.Target>> =>
  Option.match(PlannedRecord.effectiveChoice(planned), {
    onNone: () => Effect.succeed(Option.none()),
    onSome: (choice) =>
      Match.value(choice).pipe(
        Match.tag('DontAdd', () =>
          Effect.map(stubDisplayOf(planned.record), (display) =>
            Option.some(
              ReferenceTable.Stub({
                display,
                keyedBy: ImportedRecord.logicalReferenceIfKeyed(planned.record),
              })
            )
          )
        ),
        Match.orElse(() =>
          Effect.succeed(
            Option.map(HashMap.get(ids, planned.record.key), (id) =>
              ReferenceTable.Literal({
                literalReference: ImportedRecord.literalReferenceUnder(planned.record, id),
              })
            )
          )
        )
      ),
  })

/** A record of the plan beside the target a reference to it lands on. */
type RecordTarget = readonly [ImportedRecord.Type, ReferenceTable.Target]

/**
 * The target of each logical reference naming records of the import: one naming
 * exactly one record lands where that record lands; one naming several, as
 * an identifier two records share does, has none.
 */
const namedTargetsOf = (
  recordReferences: RecordReferences.Type,
  recordTargets: readonly RecordTarget[]
): readonly (readonly [LogicalReference.Type, ReferenceTable.Target])[] => {
  const targetsByKey = HashMap.fromIterable(
    recordTargets.map(([record, target]) => [record.key, target] as const)
  )
  return Arr.filterMap(recordReferences.named, ({ logicalReference, keys }) =>
    pipe(
      onlyElement(keys),
      Option.flatMap((key) => HashMap.get(targetsByKey, key)),
      Option.map((target) => [logicalReference, target] as const)
    )
  )
}

/**
 * The target of each logical reference naming no record of the import: a literal
 * to the one stored copy of the record it names
 * (`StoredMatch.storedCopiesOfReference`), none when there are several or
 * none.
 */
const unresolvedTargetsOf = (
  recordReferences: RecordReferences.Type,
  storedMatch: StoredMatch.Type
): readonly (readonly [LogicalReference.Type, ReferenceTable.Target])[] =>
  Arr.filterMap(recordReferences.unresolved, (logicalReference) =>
    Option.map(
      onlyElement(StoredMatch.storedCopiesOfReference(storedMatch, logicalReference)),
      (stored) =>
        [
          logicalReference,
          ReferenceTable.Literal({ literalReference: literalReferenceOf(stored) }),
        ] as const
    )
  )

/**
 * Where a reference to each record of `plan` lands, as a reference table.
 *
 * @param plan - The plan, its choices made
 * @param ids - The id each record that is written or linked is written under
 *   or links to
 * @returns The table, reading the clock for the name a stub shows a person by
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
 * A logical reference naming no record of the import lands on the one
 * stored record found for it by identifier.
 */
const landReferences = (
  plan: ImportPlan.Type,
  ids: HashMap.HashMap<RecordKey.Type, string>
): Effect.Effect<ReferenceTable.Type> =>
  Effect.map(
    Effect.forEach(plan.records, (planned) =>
      Effect.map(
        targetOf(planned, ids),
        Option.map((target): RecordTarget => [planned.record, target])
      )
    ),
    (targets) => {
      const recordTargets = Arr.getSomes(targets)
      const recordReferences = RecordReferences.of(plan.records.map(({ record }) => record))
      return ReferenceTable.make({
        logicalReferences: [
          ...namedTargetsOf(recordReferences, recordTargets),
          ...unresolvedTargetsOf(recordReferences, plan.storedMatch),
        ],
        stageLiterals: recordTargets.map(
          ([record, target]) => [ImportedRecord.stageLiteralOf(record), target] as const
        ),
        sourceUrls: Arr.filterMap(recordTargets, ([record, target]) =>
          Option.map(
            ImportedRecord.sourceUrlOf(record),
            (sourceUrl) => [sourceUrl, target] as const
          )
        ),
      })
    }
  )

export { landReferences }
