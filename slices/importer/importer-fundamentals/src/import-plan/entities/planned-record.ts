/**
 * A planned record: one record of an import plan, every copy of it, what the
 * store holds of it, what it is suggested, and what the reviewer chose.
 *
 * @packageDocumentation
 */
import type { FhirResource } from '@wildflowerhealthio/fhir-r4/resources'
import { Match, Option, Schema } from 'effect'

import type * as ImportedRecord from './imported-record.ts'
import * as RecordChoice from './record-choice.ts'
import type * as StoredMatch from './stored-match.ts'
import * as Suggestion from './suggestion.ts'

/**
 * One record of the plan.
 *
 * @remarks
 * `record` is the imported record whole, every copy of it, matched, suggested
 * and written by its resource (`ImportedRecord.resourceOf`). `chosen` is the
 * reviewer's choice, over the suggestion's. `edit` is the reviewer's edit of
 * the record, which replaces it as it stands.
 */
interface Type {
  readonly record: ImportedRecord.Type
  /** What the store holds of it. */
  readonly storedMatch: StoredMatch.Entry
  readonly suggestion: Suggestion.Type
  readonly chosen: Option.Option<RecordChoice.Type>
  readonly edit: Option.Option<FhirResource>
}

/**
 * How the plan counts a record by its choice: `Create`, `Update`,
 * `LinkToExisting`, `DontAdd` or `Open` (no choice yet).
 */
const LabelSchema = Schema.Literal('Create', 'Update', 'LinkToExisting', 'DontAdd', 'Open')

type Label = typeof LabelSchema.Type

/** Every {@link Label}, in the order the plan's totals list them. */
const labels: readonly Label[] = LabelSchema.literals

/** A record of the plan as suggested: nothing chosen and nothing edited. */
const make = ({
  record,
  storedMatch,
  suggestion,
}: Pick<Type, 'record' | 'storedMatch' | 'suggestion'>): Type => ({
  record,
  storedMatch,
  suggestion,
  chosen: Option.none(),
  edit: Option.none(),
})

/** `planned` with the reviewer's `choice`. */
const withChoice = (planned: Type, choice: RecordChoice.Type): Type => ({
  ...planned,
  chosen: Option.some(choice),
})

/** `planned` with the reviewer's choice cleared, back to its suggestion. */
const withChoiceCleared = (planned: Type): Type => ({ ...planned, chosen: Option.none() })

/** `planned` edited to `edit`, or with its edit cleared by `None`. */
const withEdit = (planned: Type, edit: Option.Option<FhirResource>): Type => ({ ...planned, edit })

/** The choice the import makes for `planned`: the reviewer's, else the suggestion's. */
const effectiveChoice = (planned: Type): Option.Option<RecordChoice.Type> =>
  Option.orElse(planned.chosen, () => planned.suggestion.choice)

/**
 * `planned`'s label, by its effective choice: save as new is `Create`; merge
 * into existing is `Update` when it takes a field or the record is edited,
 * else `LinkToExisting`; don't add is `DontAdd`; no choice is `Open`.
 *
 * @remarks
 * `Update` and `LinkToExisting` are both merges: the record's identity goes
 * into the existing record either way, and the label says whether content
 * is taken too.
 */
const labelOf = (planned: Type): Label =>
  Option.match(effectiveChoice(planned), {
    onNone: (): Label => 'Open',
    onSome: (choice) =>
      Match.value(choice).pipe(
        Match.tagsExhaustive({
          SaveAsNewRecord: (): Label => 'Create',
          DontAdd: (): Label => 'DontAdd',
          MergeIntoExistingRecord: (merge): Label =>
            RecordChoice.takesNoField(merge) && Option.isNone(planned.edit)
              ? 'LinkToExisting'
              : 'Update',
        })
      ),
  })

/** Whether `planned` is listed under Needs a decision, by its suggestion's reason. */
const needsDecision = (planned: Type): boolean =>
  Suggestion.needsDecision(planned.suggestion.reason)

/** Whether the reviewer chose something other than the suggestion's choice. */
const isChanged = (planned: Type): boolean =>
  Option.exists(
    planned.chosen,
    (chosen) =>
      !Option.exists(planned.suggestion.choice, (suggested) =>
        RecordChoice.equivalence(suggested, chosen)
      )
  )

export {
  effectiveChoice,
  isChanged,
  LabelSchema,
  labelOf,
  labels,
  make,
  needsDecision,
  withChoice,
  withChoiceCleared,
  withEdit,
}
export type { Label, Type }
