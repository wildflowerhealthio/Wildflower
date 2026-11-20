/**
 * Resolve a plan: which id each record of an import plan is written under,
 * what each choice writes, and when a record a reference only implied is
 * written.
 *
 * @packageDocumentation
 */
import { randomResourceId } from '@wildflowerhealthio/fhir-r4-adoption'
import { type FhirResourceWithId, ResourceReferences } from '@wildflowerhealthio/fhir-r4/resources'
import { Array as Arr, Effect, HashMap, HashSet, Match, Option, Order } from 'effect'

import type * as ImportPlan from '../entities/import-plan.ts'
import * as ImportedRecord from '../entities/imported-record.ts'
import * as KeptRecord from '../entities/kept-record.ts'
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

/** Records' facts in the order they merge into a kept record (`ImportedRecord.mergeOrder`). */
const byMergeOrder = Order.mapInput(
  ImportedRecord.mergeOrder,
  ({ planned }: PlanResolution.RecordFacts) => planned.record
)

/**
 * Each stored record `records` merge into, with every one of their merges made in
 * merge order (`ImportedRecord.mergeOrder`, then plan order, as suggesting
 * the plan made them; `KeptRecord.withRecordChoice`).
 *
 * @param records - The records' facts, in plan order
 */
const keptRecordsOf = (records: readonly PlanResolution.RecordFacts[]): KeptRecord.ByKeptRecord =>
  Arr.reduce(
    Arr.sort(records, byMergeOrder),
    KeptRecord.noneMerged,
    (keptRecords, { planned, resolved }) =>
      KeptRecord.withRecordChoice(keptRecords, PlannedRecord.effectiveChoice(planned), {
        incoming: resolved,
        isEdit: Option.isSome(planned.edit),
      })
  )

/**
 * What is written for `record`, by its effective choice: save as new writes
 * its resolved resource under its id; merge into existing writes the kept
 * record with the merges `keptRecords` holds for it (`KeptRecord.writtenIn`);
 * don't add, or no choice, writes nothing.
 */
const writtenOf = (
  { planned, id, resolved }: PlanResolution.RecordFacts,
  keptRecords: KeptRecord.ByKeptRecord
): Option.Option<FhirResourceWithId> =>
  Option.flatMap(PlannedRecord.effectiveChoice(planned), (choice) =>
    Match.value(choice).pipe(
      Match.tagsExhaustive({
        SaveAsNewRecord: () =>
          Option.map(id, (writtenId): FhirResourceWithId => ({ ...resolved, id: writtenId })),
        MergeIntoExistingRecord: ({ existing }) => KeptRecord.writtenIn(keptRecords, existing),
        DontAdd: () => Option.none(),
      })
    )
  )

/** The literal references `records`' writes hold, at any depth. */
const literalReferencesWrittenBy = (
  records: readonly PlanResolution.RecordFacts[]
): HashSet.HashSet<string> => {
  const keptRecords = keptRecordsOf(records)
  return HashSet.fromIterable(
    Arr.flatMap(records, (record) =>
      Arr.flatMap(Option.toArray(writtenOf(record, keptRecords)), (written) =>
        Arr.filterMap(ResourceReferences.collect(written), ({ reference }) =>
          Option.fromNullable(reference.reference)
        )
      )
    )
  )
}

/**
 * Whether `record` is unneeded: a record a reference only implied
 * (`ImportedRecord.isImplied`), written or linked under an id, that no
 * decoded record's write names by literal reference among `named`.
 */
const isUnneeded = (
  { planned, id }: PlanResolution.RecordFacts,
  named: HashSet.HashSet<string>
): boolean =>
  ImportedRecord.isImplied(planned.record) &&
  Option.exists(
    id,
    (written) => !HashSet.has(named, ImportedRecord.literalReferenceUnder(planned.record, written))
  )

/**
 * `plan` resolved.
 *
 * @param plan - The plan, the reviewer's choices made
 * @param mintId - Mints the id of a record saved as new over a stored record
 *   under the id the import stage gave it; random outside tests
 * @returns The resolution. It mints ids and reads the clock (for the name a
 *   stub shows a person by, `landReferences`), so one resolution is the one
 *   a preview shows and the write writes.
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
 *   replacing its content whole, and every identifier they carry added; nothing when
 *   none of them takes a field, edits it or adds an identifier
 *   (`KeptRecord`);
 * - don't add, and no choice: nothing.
 *
 * A record a reference only implied is written, or its merge made, only
 * when a decoded record's write names it; otherwise it is unneeded
 * (`PlanResolution.makeUnneededRecord`) and nothing is written for it.
 */
const resolvePlan = (
  plan: ImportPlan.Type,
  mintId: () => string = randomResourceId
): Effect.Effect<PlanResolution.Type> =>
  Effect.gen(function* () {
    const ids = idsOf(plan, mintId)
    const referenceTable = yield* landReferences(plan, ids)
    const records = yield* Effect.forEach(plan.records, (planned) =>
      Effect.map(
        ReferenceTable.resolve(referenceTable, PlannedRecord.reviewedResourceOf(planned)),
        (resolved): PlanResolution.RecordFacts => ({
          planned,
          id: HashMap.get(ids, planned.record.key),
          resolved,
        })
      )
    )
    const named = literalReferencesWrittenBy(
      records.filter(({ planned }) => !ImportedRecord.isImplied(planned.record))
    )
    const keptRecords = keptRecordsOf(records.filter((record) => !isUnneeded(record, named)))
    return PlanResolution.make(
      records.map((record) =>
        isUnneeded(record, named)
          ? PlanResolution.makeUnneededRecord(record)
          : PlanResolution.makeRecord(record, writtenOf(record, keptRecords))
      )
    )
  })

export { resolvePlan }
