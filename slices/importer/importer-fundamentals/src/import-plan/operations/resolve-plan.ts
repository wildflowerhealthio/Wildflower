/**
 * Resolve a plan: which id each record of an import plan is written under,
 * what each choice writes, and when a record a reference only implied is
 * written.
 *
 * @packageDocumentation
 */
import { randomResourceId } from '@wildflowerhealthio/fhir-r4-adoption'
import { type FhirResourceWithId, ResourceReferences } from '@wildflowerhealthio/fhir-r4/resources'
import { Array as Arr, DateTime, Effect, HashMap, HashSet, Match, Option } from 'effect'

import type * as ImportPlan from '../entities/import-plan.ts'
import * as ImportedRecord from '../entities/imported-record.ts'
import * as KeptRecords from '../entities/kept-records.ts'
import * as PlanResolution from '../entities/plan-resolution.ts'
import * as PlannedRecord from '../entities/planned-record.ts'
import type * as RecordKey from '../entities/record-key.ts'
import * as ReferenceTable from '../entities/reference-table.ts'
import { landReferences } from './land-references.ts'

/**
 * The id `planned` is saved as new under: the id the import stage gave it,
 * unless a stored record sits under that id, when one is minted.
 */
const newRecordIdOf = (planned: PlannedRecord.Type, mintId: () => string): string =>
  Option.isSome(planned.storedMatch.storedUnderDerivedId)
    ? mintId()
    : ImportedRecord.stageIdOf(planned.record).id

/**
 * The id each record of `plan` that is written or linked is written under or
 * links to: the stored record's for merge into existing, the new record's for save
 * as new ({@link newRecordIdOf}), each minted id minted once, in plan order.
 */
const idsOf = (
  plan: ImportPlan.Type,
  mintId: () => string
): HashMap.HashMap<RecordKey.Type, string> =>
  HashMap.fromIterable(
    Arr.filterMap(plan.records, (planned) =>
      Option.flatMap(PlannedRecord.effectiveChoice(planned), (choice) =>
        Match.value(choice).pipe(
          Match.tagsExhaustive({
            MergeIntoExistingRecord: ({ existing }) => Option.some(existing.id),
            SaveAsNewRecord: () => Option.some(newRecordIdOf(planned, mintId)),
            DontAdd: () => Option.none(),
          }),
          Option.map((id) => [planned.record.key, id] as const)
        )
      )
    )
  )

/**
 * Each stored record `records` merge into, with every one of their merges
 * (`KeptRecords.fromRecordChoices`), each record bringing its resolved
 * resource.
 */
const keptRecordsOf = (records: readonly PlanResolution.RecordFacts[]): KeptRecords.Type =>
  KeptRecords.fromRecordChoices(
    records.map(({ planned, resolved }) => ({ planned, incoming: resolved }))
  )

/**
 * What is written for `record`, by its effective choice: save as new writes
 * its resolved resource under its id; merge into existing writes the kept
 * record with the merges `keptRecords` holds for it and its links landed by
 * `table` (`KeptRecords.writtenIn`); don't add, or no choice, writes nothing.
 */
const writtenOf = (
  { planned, id, resolved }: PlanResolution.RecordFacts,
  keptRecords: KeptRecords.Type,
  table: ReferenceTable.Type
): Option.Option<FhirResourceWithId> =>
  Option.flatMap(
    PlannedRecord.effectiveChoice(planned),
    (choice): Option.Option<FhirResourceWithId> =>
      Match.value(choice).pipe(
        Match.tagsExhaustive({
          SaveAsNewRecord: () => Option.map(id, (writtenId) => ({ ...resolved, id: writtenId })),
          MergeIntoExistingRecord: ({ existing }) =>
            KeptRecords.writtenIn(table, keptRecords, existing),
          DontAdd: () => Option.none(),
        })
      )
  )

/** The literal references `records`' writes hold, at any depth. */
const literalReferencesWrittenBy = (
  records: readonly PlanResolution.RecordFacts[],
  table: ReferenceTable.Type
): HashSet.HashSet<string> => {
  const keptRecords = keptRecordsOf(records)
  const writes = Arr.getSomes(records.map((record) => writtenOf(record, keptRecords, table)))
  return HashSet.fromIterable(
    writes.flatMap((written) =>
      Arr.filterMap(ResourceReferences.collect(written), ({ reference }) =>
        Option.fromNullable(reference.reference)
      )
    )
  )
}

/**
 * Whether `record` is left out: a record a reference only implied
 * (`ImportedRecord.isImplied`), written or linked under an id, that no
 * decoded record's write names by literal reference among `named`. Nothing
 * is written for it and its merge is not made.
 */
const isLeftOut = (
  { planned, id }: PlanResolution.RecordFacts,
  named: HashSet.HashSet<string>
): boolean =>
  ImportedRecord.isImplied(planned.record) &&
  Option.exists(
    id,
    (written) => !HashSet.has(named, ImportedRecord.literalReferenceUnder(planned.record, written))
  )

/**
 * Whether `record`'s choice, made alone, writes something: it is saved as
 * new, or it merges into a stored record and has a field, an edit, an identifier or
 * a link to add to it.
 */
const writesAlone = (record: PlanResolution.RecordFacts, table: ReferenceTable.Type): boolean =>
  Option.isSome(writtenOf(record, keptRecordsOf([record]), table))

/**
 * `record` resolved when it is left out ({@link isLeftOut}): `Unneeded` when
 * its choice would otherwise have written something ({@link writesAlone}),
 * else labelled by its choice, writing nothing either way.
 */
const leftOutRecordOf = (
  record: PlanResolution.RecordFacts,
  table: ReferenceTable.Type
): PlanResolution.ResolvedRecord =>
  writesAlone(record, table)
    ? PlanResolution.makeUnneededRecord(record)
    : PlanResolution.makeRecord(record, Option.none())

/**
 * `plan` resolved.
 *
 * @param plan - The plan, the reviewer's choices made
 * @param mintId - Mints the id of a record saved as new over a stored record
 *   under the id the import stage gave it; random outside tests
 * @returns The resolution. It mints ids and reads the clock once (for the
 *   name a stub shows a person by, `landReferences`), so one resolution is
 *   the one a preview shows and the write writes.
 *
 * @remarks
 * Every record gets its id ({@link idsOf}), the plan's choices say where a
 * reference to each lands (`landReferences`), and each record as reviewed,
 * its edit or its resource, is resolved by that table. What is written
 * follows:
 * - save as new: the resolved resource under its id;
 * - merge into existing: the kept record with the taken fields of every
 *   record that merges into it laid over it in merge order (decoded records
 *   before implied ones, each in plan order), later winning, an edit
 *   replacing its content whole, every identifier they carry added, and each
 *   of its unlinked references linked where the table lands it on a literal;
 *   nothing when none of them takes a field, edits it or adds an identifier
 *   and no reference gains its link (`KeptRecord`);
 * - don't add, and no choice: nothing.
 *
 * A record a reference only implied is written, or its merge made, only
 * when a decoded record's write names it; otherwise nothing is written for
 * it, and it is unneeded (`PlanResolution.makeUnneededRecord`) when its
 * choice would have written something, else labelled by its choice.
 */
const resolvePlan = (
  plan: ImportPlan.Type,
  mintId: () => string = randomResourceId
): Effect.Effect<PlanResolution.Type> =>
  Effect.map(DateTime.now, (now) => {
    const ids = idsOf(plan, mintId)
    const referenceTable = landReferences(now, plan, ids)
    const records = plan.records.map((planned): PlanResolution.RecordFacts => ({
      planned,
      id: HashMap.get(ids, planned.record.key),
      resolved: ReferenceTable.resolve(referenceTable, PlannedRecord.reviewedResourceOf(planned)),
    }))
    const named = literalReferencesWrittenBy(
      records.filter(({ planned }) => !ImportedRecord.isImplied(planned.record)),
      referenceTable
    )
    const keptRecords = keptRecordsOf(records.filter((record) => !isLeftOut(record, named)))
    return PlanResolution.make(
      records.map((record) =>
        isLeftOut(record, named)
          ? leftOutRecordOf(record, referenceTable)
          : PlanResolution.makeRecord(record, writtenOf(record, keptRecords, referenceTable))
      )
    )
  })

export { resolvePlan }
