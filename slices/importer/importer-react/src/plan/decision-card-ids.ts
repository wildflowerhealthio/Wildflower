/**
 * What a Needs a decision card is known by: its DOM id, which the import bar
 * scrolls to, and its React key.
 *
 * @packageDocumentation
 */
import type { ImportPlan, RecordKey } from '@wildflowerhealthio/importer-fundamentals'
import { Array as Arr, Equal, Match, Option } from 'effect'

/**
 * The DOM id of the card of the record at `index` in its plan's records.
 * The index is the record's for as long as the plan is up: a choice makes a
 * new plan of the same records in the same order.
 */
const decisionCardDomId = (index: number): string => `import-plan-record-${index}`

/** The DOM id of the card of the record of `plan` under `key`; `None` when no record is under it. */
const decisionCardDomIdOf = (plan: ImportPlan.Type, key: RecordKey.Type): Option.Option<string> =>
  Option.map(
    Arr.findFirstIndex(plan.records, (planned) => Equal.equals(planned.record.key, key)),
    decisionCardDomId
  )

/** `key` as text, one text per key: its kind, then what it keys by. */
const recordKeyText = (key: RecordKey.Type): string =>
  Match.value(key).pipe(
    Match.tagsExhaustive({
      ByIdentifier: ({ logicalReferenceKey }) => `identifier:${logicalReferenceKey}`,
      BySourceUrl: ({ sourceUrl }) => `source-url:${sourceUrl}`,
      ByImporterAssignedKey: ({ importerAssignedKey }) => `importer:${importerAssignedKey}`,
    })
  )

export { decisionCardDomId, decisionCardDomIdOf, recordKeyText }
