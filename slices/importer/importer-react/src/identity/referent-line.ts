/**
 * The lines of one resource type's group in the referent block: each
 * referent with the choice it shows, the options its select offers and the
 * warning under it, built so a select change rebuilds only the lines it
 * changed.
 *
 * @remarks
 * A referent with a resource linked to a stored resource whose demographics
 * differ (`DifferingDemographics`) gets a warning line, and the link stands.
 *
 * @packageDocumentation
 */

import {
  DifferingDemographics,
  LinkChoice,
  Referent,
} from '@wildflowerhealthio/importer-fundamentals'
import { Array, Effect, HashMap, Option } from 'effect'

import * as LinkChoiceOptions from './link-choice-options.ts'
import { differingDemographicsWarning } from './referent-text.ts'

/** One referent with the choice it shows, the options its select offers, and the warning under it. */
interface ReferentLine {
  readonly referent: Referent.Type
  readonly choice: LinkChoice.Type
  readonly options: LinkChoiceOptions.Type
  readonly warning: Option.Option<string>
}

/** Everything a group's lines are built from. */
type ReferentLineInputs = LinkChoiceOptions.Inputs & {
  /** The referents that write a record of their own, which every other line's "New:" options list. */
  readonly ownRecordWritersKey: string
}

/** A line with what it was built from, so the next build can keep it when that has not changed. */
interface BuiltReferentLine {
  readonly line: ReferentLine
  readonly choiceValue: string
  readonly inputs: ReferentLineInputs
}

/**
 * The warning for a referent with a resource linked to a stored resource whose
 * demographics differ, or `None`.
 */
const differingDemographicsWarningFor = (
  referent: Referent.Type,
  choice: LinkChoice.Type
): Effect.Effect<Option.Option<string>> =>
  Option.all({
    decoded: Option.liftPredicate(referent, Referent.is('AsResource')),
    stored: Option.liftPredicate(choice, LinkChoice.is('LinkToStoredResource')),
  }).pipe(
    Effect.transposeMapOption(({ decoded, stored }) =>
      DifferingDemographics.between(decoded.resource, stored.resource)
    ),
    Effect.map(
      Option.flatMap((differing) =>
        Option.map(
          Option.liftPredicate(differing, Array.isNonEmptyReadonlyArray),
          differingDemographicsWarning
        )
      )
    )
  )

/**
 * Whether `before` was built from the same inputs a line with `choiceValue`
 * under `inputs` would be: its own choice, the stored list and its options,
 * the batch's referents and which of them write their own record. The
 * choices and link targets themselves change on every select, and a line
 * reads them only through those.
 */
const builtFromSame = (
  before: BuiltReferentLine,
  choiceValue: string,
  inputs: ReferentLineInputs
): boolean =>
  before.choiceValue === choiceValue &&
  before.inputs.ownRecordWritersKey === inputs.ownRecordWritersKey &&
  before.inputs.storedOfType === inputs.storedOfType &&
  before.inputs.onServer === inputs.onServer &&
  before.inputs.referents === inputs.referents

/**
 * The lines of `ofType` under `inputs`, each kept from `previous` when it was
 * built from the same inputs, so a select change rebuilds only the lines it
 * changed and every other keeps its options and warning by identity, which
 * `ReferentRow`'s memo compares. `previous` itself when every line is kept.
 * The warning reads the clock (which name is current) and nothing else, so it
 * runs synchronously here, as the identity map hook runs the placing.
 */
const buildAll = (
  ofType: readonly Referent.Type[],
  inputs: ReferentLineInputs,
  previous: HashMap.HashMap<string, BuiltReferentLine>
): HashMap.HashMap<string, BuiltReferentLine> => {
  const entries = ofType.map((referent) => {
    const referentKey = Referent.key(referent)
    const choice = LinkChoice.forReferent(inputs.linkChoices, referent)
    const choiceValue = LinkChoiceOptions.valueOf(choice)
    const built = HashMap.get(previous, referentKey).pipe(
      Option.filter((before) => builtFromSame(before, choiceValue, inputs)),
      Option.getOrElse((): BuiltReferentLine => ({
        choiceValue,
        inputs,
        line: {
          referent,
          choice,
          options: LinkChoiceOptions.forReferent(referent, choice, inputs),
          warning: Effect.runSync(differingDemographicsWarningFor(referent, choice)),
        },
      }))
    )
    return [referentKey, built] as const
  })
  const everyLineKept =
    HashMap.size(previous) === entries.length &&
    entries.every(([referentKey, built]) =>
      Option.exists(HashMap.get(previous, referentKey), (before) => before === built)
    )
  return everyLineKept ? previous : HashMap.fromIterable(entries)
}

export { buildAll }
export type { BuiltReferentLine as Built, ReferentLineInputs as Inputs, ReferentLine as Type }
