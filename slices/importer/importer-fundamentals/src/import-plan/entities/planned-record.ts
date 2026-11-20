/**
 * A planned record: one record of an import plan, every copy of it, what the
 * store holds of it, what it is suggested, and what the reviewer chose.
 *
 * @packageDocumentation
 */
import type { FhirResource } from '@wildflowerhealthio/fhir-r4/resources'
import { Match, Option } from 'effect'

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
 * `LinkToExisting`, `DontAdd` (not counted) or `Open` (no choice yet).
 */
type Label = 'Create' | 'Update' | 'LinkToExisting' | 'DontAdd' | 'Open'

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

/** The choice the import makes for `planned`: the reviewer's, else the suggestion's. */
const effectiveChoice = (planned: Type): Option.Option<RecordChoice.Type> =>
  Option.orElse(planned.chosen, () => planned.suggestion.choice)

/**
 * `planned`'s label, by its effective choice: save as new is `Create`; use
 * existing is `Update` when it takes a field or the record is edited, else
 * `LinkToExisting`; don't add is `DontAdd`; no choice is `Open`.
 */
const labelOf = (planned: Type): Label =>
  Option.match(effectiveChoice(planned), {
    onNone: (): Label => 'Open',
    onSome: (choice) =>
      Match.value(choice).pipe(
        Match.tagsExhaustive({
          SaveAsNewRecord: (): Label => 'Create',
          DontAdd: (): Label => 'DontAdd',
          UseExistingRecord: (useExisting): Label =>
            RecordChoice.takesNothing(useExisting) && Option.isNone(planned.edit)
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

export { effectiveChoice, isChanged, labelOf, make, needsDecision }
export type { Label, Type }
