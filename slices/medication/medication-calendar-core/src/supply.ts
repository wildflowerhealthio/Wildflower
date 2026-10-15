import {
  type SupplyDuration,
  supplyDurationToParts,
  type UnusableSupplyDuration,
} from '@wildflowerhealthio/fhir-utility'
import { Data, DateTime, Either } from 'effect'

/** The authored date is not an instant `DateTime.make` can parse. */
class AuthoredDateUnparseable extends Data.TaggedError('AuthoredDateUnparseable')<{
  readonly authoredOnIso: string
}> {}

/**
 * The authored date advanced by the supply duration lands outside the range a
 * JavaScript date can represent (about 275,000 years either side of 1970).
 */
class NextFillDatePastRepresentableRange extends Data.TaggedError(
  'NextFillDatePastRepresentableRange'
) {}

/**
 * Why there is no next-fill date: the supply duration is unusable (one of
 * `fhir-utility`'s {@link UnusableSupplyDuration} cases, passed through), the
 * authored date does not parse, or the advanced date is out of range.
 */
type NextFillDateFailure =
  | UnusableSupplyDuration
  | AuthoredDateUnparseable
  | NextFillDatePastRepresentableRange

/**
 * Estimated next-fill date as an ISO instant: `authoredOnIso` advanced by
 * `supply` (i.e. when the current supply runs out). Total, never throws: every
 * reason there is no date is a {@link NextFillDateFailure} case on the left.
 * The supply duration is checked before the authored date.
 *
 * The authored date is taken as an ISO string (not a parsed instant) so this
 * stays FHIR-free; the caller formats its decoded date to ISO first. The
 * `SupplyDuration` shape and parser come from `fhir-utility` — a supply
 * duration is a FHIR concept, not a calendar one.
 */
const nextFillDate = (
  authoredOnIso: string,
  supply: SupplyDuration
): Either.Either<string, NextFillDateFailure> =>
  Either.gen(function* () {
    const parts = yield* supplyDurationToParts(supply)
    const authored = yield* Either.fromOption(
      DateTime.make(authoredOnIso),
      () => new AuthoredDateUnparseable({ authoredOnIso })
    )
    const exhausted = DateTime.add(authored, parts)
    if (!Number.isFinite(exhausted.epochMillis)) {
      return yield* Either.left(new NextFillDatePastRepresentableRange())
    }
    return DateTime.formatIso(exhausted)
  })

export {
  AuthoredDateUnparseable,
  nextFillDate,
  type NextFillDateFailure,
  NextFillDatePastRepresentableRange,
}
