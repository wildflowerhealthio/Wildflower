import { Option } from 'effect'

import type * as Extraction from './extraction.ts'

/**
 * How an importer claims a set of responses with no user configuration —
 * "this traffic is mine, and here is how specific that claim is".
 *
 * @remarks
 * An import asks the user for nothing but a file, so *which* importer
 * understands an archive has to be read off the traffic itself. Each importer
 * declares one of these next to its entities (by URL or payload shape), and
 * {@link resolve} picks between the ones that claim.
 *
 * `specificity` is a plain number, higher wins. The intended ranking across
 * the importers is portal-specific (a named patient portal) above
 * protocol-generic (any FHIR server) above catch-all (a recorder that claims
 * everything) — a convention between the recognizers, not an enum this package
 * polices, so a new kind of importer needs no change here. Keep the values
 * spread out enough to insert between.
 *
 * `claims` must be pure and total, and sees the same structural
 * {@link Extraction.Input}s the extraction runner does — a recognizer and the
 * entities it speaks for read the same evidence.
 *
 * The interface is open by design — the resolver is generic in it, so a caller
 * carries its own payload (an `Importer.Importer`'s tag and entities) on the
 * same value rather than maintaining a parallel lookup keyed by name.
 */
interface Recognizer {
  /** Stable identifier, for logging and for a caller's own lookup. */
  readonly name: string
  /** Higher wins. See the ranking convention in the interface remarks. */
  readonly specificity: number
  readonly claims: (responses: readonly Extraction.Input[]) => boolean
}

/**
 * Pick the most specific recognizer that claims `responses`.
 *
 * @typeParam TRecognizer - The caller's recognizer type; whatever it carries
 *   alongside the {@link Recognizer} fields comes back untouched
 * @param recognizers - The candidates, in any order
 * @param responses - The responses to offer them
 * @returns The claiming candidate with the highest `specificity`, or `None`
 *   when none claims
 *
 * @remarks
 * Ties break toward the earliest candidate in `recognizers`, so the result is
 * deterministic even when two importers declare the same specificity — but a
 * tie means the ranking is under-specified, and the fix is to separate the two
 * `specificity` values, not to rely on list order.
 *
 * Every candidate's `claims` runs, including ones that cannot win: the
 * predicates are pure and the candidate list is a handful of importers, so
 * short-circuiting would buy nothing and would make the result depend on the
 * order they were listed in.
 */
const resolve = <TRecognizer extends Recognizer>(
  recognizers: readonly TRecognizer[],
  responses: readonly Extraction.Input[]
): Option.Option<TRecognizer> =>
  Option.fromNullable(
    recognizers
      .filter((recognizer) => recognizer.claims(responses))
      .reduce<TRecognizer | undefined>(
        (best, candidate) =>
          best === undefined || candidate.specificity > best.specificity ? candidate : best,
        undefined
      )
  )

export { resolve }
export type { Recognizer }
