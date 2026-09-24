import { Option, pipe, Schema } from 'effect'

import { Extension, WildflowerExtension } from 'fhir-r4/data-types'
import type { MedicationRequestDispenseRequest } from 'fhir-r4/resources'

import { CarebookExtension } from '../carebook.ts'
import { type Lifted, liftExtension } from './lift.ts'

/**
 * The dialect's dual-written remaining-repeats `modifierExtension` pair → one
 * {@link WildflowerExtension.RepeatsAvailable} `valueInteger` on the dispense
 * request's `extension`.
 *
 * @remarks
 * `v1` (`valuePositiveInt`) is preferred, `v2` (`valueDecimal`) the fallback.
 * The two copies are consumed **by value, not by url**: each is dropped only
 * when it carries the promoted number — see AGENTS.md under "Extension
 * Promotion".
 */

type DispenseRequest = typeof MedicationRequestDispenseRequest.Schema.Type

/**
 * A remaining-repeats count: a non-negative *safe* integer. A fractional,
 * negative or out-of-range value is not a count, so its extension stays put.
 */
const SafeRepeatCount = Schema.NonNegativeInt

/** The `v1` remaining-repeats copy, a `positiveInt`. */
const RepeatsAvailableV1 = Schema.pluck(
  Schema.Struct({ valuePositiveInt: SafeRepeatCount }),
  'valuePositiveInt'
)

/** The `v2` remaining-repeats copy, the same number as a `decimal`. */
const RepeatsAvailableV2 = Schema.pluck(
  Schema.Struct({ valueDecimal: SafeRepeatCount }),
  'valueDecimal'
)

/** Reads the first `v1` remaining-repeats copy. */
const liftRepeatsAvailableV1 = liftExtension(
  CarebookExtension.NumberOfRepeatsAvailable,
  RepeatsAvailableV1
)

/** Reads the first `v2` remaining-repeats copy. */
const liftRepeatsAvailableV2 = liftExtension(
  CarebookExtension.NumberOfRepeatsAvailableV2,
  RepeatsAvailableV2
)

/**
 * A {@link WildflowerExtension.RepeatsAvailable} entry holding `count`, unless
 * the list already carries one.
 */
const withRepeatsAvailable = (
  extensions: readonly Extension.Type[],
  count: number
): readonly Extension.Type[] =>
  extensions.some(Extension.hasUrl(WildflowerExtension.RepeatsAvailable))
    ? extensions
    : [
        ...extensions,
        {
          ...Extension.emptyValueChoice,
          id: null,
          extension: [],
          url: WildflowerExtension.RepeatsAvailable,
          valueInteger: count,
        },
      ]

/**
 * Drop the copy `lift` reads only if it carries exactly `count` — a copy that
 * disagrees with the promoted number is a value nobody promoted, and stays.
 */
const withoutCopyCarrying =
  (lift: (extensions: readonly Extension.Type[]) => Option.Option<Lifted<number>>, count: number) =>
  (extensions: readonly Extension.Type[]): readonly Extension.Type[] =>
    pipe(
      lift(extensions),
      Option.filter(({ value }) => value === count),
      Option.match({ onNone: () => extensions, onSome: ({ remaining }) => remaining })
    )

/** The remaining-repeats pair → one Wildflower `valueInteger`. */
const promoteRepeatsAvailable = (dispenseRequest: DispenseRequest): DispenseRequest =>
  pipe(
    liftRepeatsAvailableV1(dispenseRequest.modifierExtension),
    Option.orElse(() => liftRepeatsAvailableV2(dispenseRequest.modifierExtension)),
    Option.match({
      onNone: () => dispenseRequest,
      onSome: ({ value: count }) => ({
        ...dispenseRequest,
        modifierExtension: pipe(
          dispenseRequest.modifierExtension,
          withoutCopyCarrying(liftRepeatsAvailableV1, count),
          withoutCopyCarrying(liftRepeatsAvailableV2, count)
        ),
        extension: withRepeatsAvailable(dispenseRequest.extension, count),
      }),
    })
  )

export { promoteRepeatsAvailable }
