/**
 * A planned record: one record of an import plan, every copy of it, what the
 * store holds of it, what it is suggested, and what the reviewer chose.
 *
 * @packageDocumentation
 */
import { type FhirResource, sameStoredResource } from '@wildflowerhealthio/fhir-r4/resources'
import { Array as Arr, Match, Option, Schema } from 'effect'

import * as ExistingRecord from './existing-record.ts'
import * as ImportedRecord from './imported-record.ts'
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
 * A record's label by its choice: `Create`, `Update`, `LinkToExisting`,
 * `DontAdd` or `Open` (no choice yet). The plan's totals count a resolved
 * record by `PlanResolution.Label`, which adds what resolving alone knows.
 */
const LabelSchema = Schema.Literal('Create', 'Update', 'LinkToExisting', 'DontAdd', 'Open')

type Label = typeof LabelSchema.Type

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

/** `planned` as reviewed: the reviewer's edit, else its resource (`ImportedRecord.resourceOf`). */
const reviewedResourceOf = (planned: Type): FhirResource =>
  Option.getOrElse(planned.edit, () => ImportedRecord.resourceOf(planned.record))

/** The choice the import makes for `planned`: the reviewer's, else the suggestion's. */
const effectiveChoice = (planned: Type): Option.Option<RecordChoice.Type> =>
  Option.orElse(planned.chosen, () => planned.suggestion.choice)

/**
 * Every existing record `planned` could merge into, each stored resource once
 * (`sameStoredResource`, the first kept): the search's candidates in the
 * entry's order, best grade first, `possible` ones included; then the record
 * stored under its derived id, when no candidate is that stored resource;
 * then the existing record the reviewer's own choice merges into, when
 * none of those is it.
 *
 * @remarks
 * A `possible` match is listed though no suggestion counts it
 * (`StoredMatch.nameMatchesOf`).
 */
const existingRecordsOf = (planned: Type): readonly ExistingRecord.Type[] =>
  Arr.dedupeWith(
    [
      ...planned.storedMatch.candidates.map(({ resource, grade, by }): ExistingRecord.Type => ({
        resource,
        knownBy: ExistingRecord.MatchedBySearch({ grade, evidence: by }),
      })),
      ...Option.toArray(planned.storedMatch.storedUnderDerivedId).map(
        (resource): ExistingRecord.Type => ({
          resource,
          knownBy: ExistingRecord.StoredUnderDerivedId(),
        })
      ),
      ...Option.toArray(
        Option.filter(planned.chosen, RecordChoice.is('MergeIntoExistingRecord'))
      ).map(({ existing }): ExistingRecord.Type => ({
        resource: existing,
        knownBy: ExistingRecord.ChosenByReviewer(),
      })),
    ],
    (left, right) => sameStoredResource(left.resource, right.resource)
  )

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
  existingRecordsOf,
  isChanged,
  LabelSchema,
  labelOf,
  make,
  needsDecision,
  reviewedResourceOf,
  withChoice,
  withChoiceCleared,
  withEdit,
}
export type { Label, Type }
