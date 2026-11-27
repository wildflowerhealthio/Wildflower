/**
 * Resolve a plan: which id each record of an import plan is written under,
 * what each choice writes, and when a record a reference only implied is
 * written.
 *
 * @packageDocumentation
 */
import { randomResourceId } from '@wildflowerhealthio/fhir-r4-adoption'
import { type FhirResourceWithId, ResourceReferences } from '@wildflowerhealthio/fhir-r4/resources'
import {
  Array as Arr,
  DateTime,
  Effect,
  HashMap,
  HashSet,
  Match,
  Option,
  pipe,
  Record,
} from 'effect'

import type * as ImportPlan from '../entities/import-plan.ts'
import * as ImportedRecord from '../entities/imported-record.ts'
import * as KeptRecords from '../entities/kept-records.ts'
import * as PlanResolution from '../entities/plan-resolution.ts'
import * as PlannedRecord from '../entities/planned-record.ts'
import * as RecordChoice from '../entities/record-choice.ts'
import type * as RecordKey from '../entities/record-key.ts'
import * as ReferenceTable from '../entities/reference-table.ts'
import { landReferences } from './land-references.ts'

/**
 * The id `planned` is saved as new under: the id the import stage gave it,
 * unless a stored record sits under that id, when one is minted.
 */
const newRecordIdOf = (mintId: () => string, planned: PlannedRecord.Type): string =>
  Option.isSome(planned.storedMatch.storedUnderDerivedId)
    ? mintId()
    : ImportedRecord.stageIdOf(planned.record).id

/**
 * The id each record of `plan` that is written or linked is written under or
 * links to: the stored record's for merge into existing, the new record's for save
 * as new ({@link newRecordIdOf}), each minted id minted once, in plan order.
 */
const idsOf = (
  mintId: () => string,
  plan: ImportPlan.Type
): HashMap.HashMap<RecordKey.Type, string> =>
  HashMap.fromIterable(
    Arr.filterMap(plan.records, (planned) =>
      Option.flatMap(PlannedRecord.effectiveChoice(planned), (choice) =>
        Match.value(choice).pipe(
          Match.tagsExhaustive({
            MergeIntoExistingRecord: ({ existing }) => Option.some(existing.id),
            SaveAsNewRecord: () => Option.some(newRecordIdOf(mintId, planned)),
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
const keptRecordsOf = (records: readonly PlanResolution.LandedRecord[]): KeptRecords.Type =>
  KeptRecords.fromRecordChoices(
    records.map(({ planned, resolved }) => ({ planned, incoming: resolved }))
  )

/** What is written for `record` when it is saved as new: its resolved resource under its id. */
const newRecordWriteOf = ({
  planned,
  id,
  resolved,
}: PlanResolution.LandedRecord): Option.Option<FhirResourceWithId> =>
  pipe(
    PlannedRecord.effectiveChoice(planned),
    Option.filter(RecordChoice.is('SaveAsNewRecord')),
    Option.flatMap(() => id),
    Option.map((writtenId) => ({ ...resolved, id: writtenId }))
  )

/**
 * Every resource `records` write between them: each record saved as new
 * ({@link newRecordWriteOf}), and each stored record they merge into that is
 * written, once, with all their merges and its links landed by `table`
 * (`KeptRecords.writesOf`).
 */
const writesOf = (
  table: ReferenceTable.Type,
  records: readonly PlanResolution.LandedRecord[]
): readonly FhirResourceWithId[] => [
  ...Arr.getSomes(records.map(newRecordWriteOf)),
  ...Record.values(KeptRecords.writesOf(table, keptRecordsOf(records))),
]

/** The literal references `resources` hold, at any depth. */
const literalReferencesIn = (resources: readonly FhirResourceWithId[]): HashSet.HashSet<string> =>
  HashSet.fromIterable(
    resources.flatMap((resource) =>
      Arr.filterMap(ResourceReferences.collect(resource), ({ reference }) =>
        Option.fromNullable(reference.reference)
      )
    )
  )

/**
 * Whether `record` is left out: a record a reference only implied
 * (`ImportedRecord.isImplied`), written or linked under an id, that no
 * decoded record's write names by literal reference among `named`. Nothing
 * is written for it and its merge is not made.
 */
const isLeftOut = (
  named: HashSet.HashSet<string>,
  { planned, id }: PlanResolution.LandedRecord
): boolean =>
  ImportedRecord.isImplied(planned.record) &&
  Option.exists(
    id,
    (written) => !HashSet.has(named, ImportedRecord.literalReferenceUnder(planned.record, written))
  )

/**
 * `record` resolved when it is left out ({@link isLeftOut}), nothing written
 * for it: `Unneeded` when its choice, made alone, writes something (it is
 * saved as new, or it merges into a stored record and has a field, an edit,
 * an identifier or a link to add to it), else labelled by its choice.
 */
const leftOutRecordOf = (
  table: ReferenceTable.Type,
  record: PlanResolution.LandedRecord
): PlanResolution.ResolvedRecord =>
  Arr.isNonEmptyReadonlyArray(writesOf(table, [record]))
    ? PlanResolution.makeUnneededRecord(record)
    : PlanResolution.makeRecord(record, Option.none())

/**
 * What is written for `record`, by its effective choice: save as new writes
 * its resolved resource under its id ({@link newRecordWriteOf}); merge into
 * existing writes what `keptWrites` holds for the stored record it merges
 * into, the one write every record merging into it shares; don't add, or no
 * choice, writes nothing.
 */
const writtenOf = (
  keptWrites: KeptRecords.Writes,
  record: PlanResolution.LandedRecord
): Option.Option<FhirResourceWithId> =>
  Option.flatMap(
    PlannedRecord.effectiveChoice(record.planned),
    (choice): Option.Option<FhirResourceWithId> =>
      Match.value(choice).pipe(
        Match.tagsExhaustive({
          SaveAsNewRecord: () => newRecordWriteOf(record),
          MergeIntoExistingRecord: ({ existing }) => KeptRecords.writeFor(keptWrites, existing),
          DontAdd: () => Option.none(),
        })
      )
  )

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
 * In order:
 * 1. Every record that is written or linked gets its id ({@link idsOf}).
 * 2. The plan's choices say where a reference to each record lands
 *    (`landReferences`).
 * 3. Each record as reviewed, its edit or its resource, has its references
 *    resolved by that table.
 * 4. A record a reference only implied is left out unless a decoded
 *    record's write names it ({@link isLeftOut}).
 * 5. Each stored record the remaining records merge into is written once
 *    (`KeptRecords.writesOf`).
 * 6. Each record is resolved, in plan order ({@link writtenOf},
 *    {@link leftOutRecordOf}).
 *
 * What is written for a record:
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
 * A record that is left out has nothing written and its merge is not made.
 * It is unneeded (`PlanResolution.makeUnneededRecord`) when its choice
 * would have written something, else labelled by its choice.
 */
const resolvePlan = (
  plan: ImportPlan.Type,
  mintId: () => string = randomResourceId
): Effect.Effect<PlanResolution.Type> =>
  Effect.map(DateTime.now, (now) => {
    const ids = idsOf(mintId, plan)
    const table = landReferences(now, plan, ids)
    const landed = plan.records.map((planned): PlanResolution.LandedRecord => ({
      planned,
      id: HashMap.get(ids, planned.record.key),
      resolved: ReferenceTable.resolve(table, PlannedRecord.reviewedResourceOf(planned)),
    }))
    const decoded = landed.filter(({ planned }) => !ImportedRecord.isImplied(planned.record))
    const namedByDecodedWrites = literalReferencesIn(writesOf(table, decoded))
    const included = landed.filter((record) => !isLeftOut(namedByDecodedWrites, record))
    const keptWrites = KeptRecords.writesOf(table, keptRecordsOf(included))
    return PlanResolution.make(
      landed.map((record) =>
        isLeftOut(namedByDecodedWrites, record)
          ? leftOutRecordOf(table, record)
          : PlanResolution.makeRecord(record, writtenOf(keptWrites, record))
      )
    )
  })

export { resolvePlan }
