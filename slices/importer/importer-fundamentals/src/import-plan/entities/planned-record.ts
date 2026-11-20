/**
 * A planned record: one record of an import plan, every copy of it, what the
 * store holds of it, what it is suggested, and what the reviewer chose.
 *
 * @packageDocumentation
 */
import type { ResourceMatch } from '@wildflowerhealthio/fhir-r4/clients'
import type { FhirResource } from '@wildflowerhealthio/fhir-r4/resources'
import type { Array as Arr } from 'effect'
import { Match, Option } from 'effect'

import * as Suggestion from '../operations/suggest-record.ts'
import type * as FileCopy from './file-copy.ts'
import * as RecordChoice from './record-choice.ts'
import type * as RecordKey from './record-key.ts'

/**
 * One record of the plan.
 *
 * @remarks
 * The first of `copies`, in plan order, is the record: the copy it is
 * matched, suggested and written by. `chosen` is the reviewer's choice, over
 * the suggestion's. `edit` is the reviewer's edit of the record, which
 * replaces it as it stands.
 */
interface Type {
  readonly key: RecordKey.Type
  readonly copies: Arr.NonEmptyReadonlyArray<FileCopy.Type>
  /** The stored records matching it, best grade first. */
  readonly candidates: readonly ResourceMatch.Candidate[]
  readonly suggestion: Suggestion.Type
  readonly chosen: Option.Option<RecordChoice.Type>
  readonly edit: Option.Option<FhirResource>
}

/**
 * How the plan counts a record by its choice: `Create`, `Update`,
 * `LinkToExisting`, `DontAdd` (not counted) or `Open` (no choice yet).
 */
type Label = 'Create' | 'Update' | 'LinkToExisting' | 'DontAdd' | 'Open'

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

export { effectiveChoice, isChanged, labelOf, needsDecision }
export type { Label, Type }
