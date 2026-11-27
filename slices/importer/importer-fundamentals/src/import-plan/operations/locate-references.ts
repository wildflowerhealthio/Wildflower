/**
 * Locate references: where each logical reference an import's records hold
 * points, in the import or outside it, in one pass.
 *
 * @packageDocumentation
 */
import { MatchQuery } from '@wildflowerhealthio/fhir-r4/clients'
import { LogicalReference, ResourceReferences } from '@wildflowerhealthio/fhir-r4/resources'
import { groupInOrder, onlyElement } from '@wildflowerhealthio/kitchen-sink'
import { Array as Arr, Data, Equal, HashMap, HashSet, Option, pipe } from 'effect'

import * as ImportedRecord from '../entities/imported-record.ts'
import * as RecordKey from '../entities/record-key.ts'
import * as RecordReferences from '../entities/record-references.ts'

/**
 * Where one distinct logical reference points.
 *
 * @remarks
 * - `InImport`: at exactly one record of the import, the one under `key`.
 * - `AmbiguousInImport`: several records of the import carry its identifier
 *   and the naming rule ({@link namedRecordKeyOf}) picks none. It is linked
 *   to none and stays as it is, and the server is not asked about it.
 * - `External`: outside the import, since no record of the import carries its
 *   identifier. These are the references the server is asked about.
 */
type Outcome = Data.TaggedEnum<{
  InImport: { readonly key: RecordKey.Type }
  // oxlint-disable-next-line typescript/no-generated-empty-object-type -- an empty variant
  AmbiguousInImport: Record<never, never>
  // oxlint-disable-next-line typescript/no-generated-empty-object-type -- an empty variant
  External: Record<never, never>
}>

const { InImport, AmbiguousInImport, External, $is: isOutcome } = Data.taggedEnum<Outcome>()

/** One qualified identifier a record keyed by identifier carries, as the logical reference that names it. */
interface Carried {
  readonly logicalReference: LogicalReference.Type
  readonly record: ImportedRecord.Type
}

/** One unlinked reference a record holds, beside the key of the record holding it. */
interface Held {
  readonly holder: RecordKey.Type
  readonly unlinkedReference: LogicalReference.Type
}

/**
 * One identifier records of the import carry: the first logical reference
 * that names it, and the key of the record it names, `None` when it names
 * none ({@link namedRecordKeyOf}).
 */
interface Identified {
  readonly logicalReference: LogicalReference.Type
  readonly named: Option.Option<RecordKey.Type>
}

/** One distinct logical reference, beside the keys of every record holding it and where it points. */
interface Located {
  readonly unlinkedReference: LogicalReference.Type
  readonly holders: Arr.NonEmptyReadonlyArray<RecordKey.Type>
  readonly outcome: Outcome
}

/**
 * Every qualified identifier the copies of `record` carry, under its type,
 * when the record is keyed by identifier.
 *
 * @remarks
 * A logical reference names a record by any of its identifiers, as a FHIR
 * conditional reference does and as `DecodedFileSet.adopt` resolves one. The
 * identifiers of a record with no key identifier name it nowhere, whether it
 * is keyed by source URL or by an importer-assigned key.
 */
const carriedBy = (record: ImportedRecord.Type): readonly Carried[] =>
  RecordKey.isKeyedByIdentifier(record.key)
    ? record.copies.flatMap(({ resource }) =>
        MatchQuery.qualifiedIdentifiersOf(resource).map((identifier): Carried => ({
          logicalReference: LogicalReference.make(resource.resourceType, identifier),
          record,
        }))
      )
    : []

/**
 * The key of the record an identifier names, among the records carrying it
 * (`carrying`, one entry per copy's identifier); `None` when it names none.
 *
 * @remarks
 * A decoded record beats an implied one: when any record carrying it has a
 * decoded copy, the records whose every copy is implied are out
 * (`ImportedRecord.isImplied`). Among those left, the record keyed by that
 * identifier wins; else the one left is named. Several left, none keyed by
 * that identifier, name none: a reference to it stays logical until two
 * imported records can be merged (#1470).
 */
const namedRecordKeyOf = (
  carrying: Arr.NonEmptyReadonlyArray<Carried>
): Option.Option<RecordKey.Type> => {
  const records = Arr.dedupeWith(
    carrying.map(({ record }) => record),
    (a, b) => Equal.equals(a.key, b.key)
  )
  const decodedRecords = records.filter((record) => !ImportedRecord.isImplied(record))
  const impliedRecords = records.filter(ImportedRecord.isImplied)
  const contenders = decodedRecords.length > 0 ? decodedRecords : impliedRecords
  const keyedByIdentifier = RecordKey.fromLogicalReference(
    Arr.headNonEmpty(carrying).logicalReference
  )
  return pipe(
    Arr.findFirst(contenders, ({ key }) => Equal.equals(key, keyedByIdentifier)),
    Option.orElse(() => onlyElement(contenders)),
    Option.map(({ key }) => key)
  )
}

/** Every unlinked reference the copies of `record` hold, at any depth, beside the record's key. */
const heldBy = (record: ImportedRecord.Type): readonly Held[] =>
  record.copies.flatMap(({ resource }) =>
    Arr.filterMap(ResourceReferences.collect(resource), ({ reference: heldReference }) =>
      Option.map(LogicalReference.tryFromReference(heldReference), (unlinkedReference): Held => ({
        holder: record.key,
        unlinkedReference,
      }))
    )
  )

/**
 * Where each distinct unlinked reference `records` hold points, and so which
 * records another references and which references are external, for the
 * server to be asked about.
 *
 * @param records - The import's records, in plan order (`ImportedRecord.fromCopies`)
 *
 * @remarks
 * One pass, in four steps, each grouping in the order its items first come
 * (`groupInOrder`): decide once per identifier which record it names
 * ({@link namedRecordKeyOf}), which gives `named`, each identifier that
 * names a record by its first-seen logical reference, in the order the
 * identifiers are first carried; group the references the records hold, so
 * each distinct one appears once, its first-seen value beside the keys of
 * every record holding it, in the order first held; give each its
 * {@link Outcome} by its identifier; and read `referenced` and `external`
 * off that list. A record is referenced when any holder of a reference
 * pointing at it is another record, so a record that only names itself is
 * not referenced.
 */
const locateReferences = (records: readonly ImportedRecord.Type[]): RecordReferences.Type => {
  const identified = groupInOrder(records.flatMap(carriedBy), ({ logicalReference }) =>
    LogicalReference.key(logicalReference)
  ).map(
    ({ key, items: carrying }) =>
      [
        key,
        {
          logicalReference: Arr.headNonEmpty(carrying).logicalReference,
          named: namedRecordKeyOf(carrying),
        } satisfies Identified,
      ] as const
  )
  const byIdentifier = HashMap.fromIterable(identified)
  const outcomeOf = (unlinkedReference: LogicalReference.Type): Outcome =>
    Option.match(HashMap.get(byIdentifier, LogicalReference.key(unlinkedReference)), {
      onNone: () => External(),
      onSome: ({ named }) =>
        Option.match(named, {
          onNone: () => AmbiguousInImport(),
          onSome: (key) => InImport({ key }),
        }),
    })
  const located = groupInOrder(records.flatMap(heldBy), ({ unlinkedReference }) =>
    LogicalReference.key(unlinkedReference)
  ).map(({ items: held }): Located => {
    const { unlinkedReference } = Arr.headNonEmpty(held)
    return {
      unlinkedReference,
      holders: Arr.map(held, ({ holder }) => holder),
      outcome: outcomeOf(unlinkedReference),
    }
  })
  return RecordReferences.make({
    referenced: HashSet.fromIterable(
      Arr.filterMap(located, ({ holders, outcome }) =>
        isOutcome('InImport')(outcome) &&
        holders.some((holder) => !Equal.equals(holder, outcome.key))
          ? Option.some(outcome.key)
          : Option.none()
      )
    ),
    named: Arr.filterMap(identified, ([, { logicalReference, named }]) =>
      Option.map(named, (key): RecordReferences.NamedRecord => ({ logicalReference, key }))
    ),
    external: located
      .filter(({ outcome }) => isOutcome('External')(outcome))
      .map(({ unlinkedReference }) => unlinkedReference),
  })
}

export { locateReferences }
