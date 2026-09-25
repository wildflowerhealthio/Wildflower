import { flow, Option, pipe, Schema, Struct } from 'effect'

import { Extension, WildflowerExtension } from 'fhir-r4/data-types'
import type { MedicationRequestDispenseRequest } from 'fhir-r4/resources'
import { Lift } from 'kitchen-sink'

import { CarebookExtension } from '../carebook.ts'
import { atUrl } from './extension-lift.ts'

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

const liftRepeatsAvailableV1 = atUrl(CarebookExtension.NumberOfRepeatsAvailable, RepeatsAvailableV1)
const liftRepeatsAvailableV2 = atUrl(
  CarebookExtension.NumberOfRepeatsAvailableV2,
  RepeatsAvailableV2
)

/** The remaining-repeats count: the `v1` copy, or else the `v2` one. */
const liftRepeatsAvailable = pipe(liftRepeatsAvailableV1, Lift.orElse(liftRepeatsAvailableV2))

/**
 * Only a copy that carries exactly `count`. A copy that disagrees with the
 * promoted number holds a value nobody promoted, so it must not be consumed.
 */
const copyCarrying = (count: number): (<E>(copies: Lift.Lift<number, E>) => Lift.Lift<number, E>) =>
  Lift.filter((copy: number) => copy === count)

/**
 * A {@link WildflowerExtension.RepeatsAvailable} entry holding `count`, unless
 * the list already carries one — a second pass must not add a second entry.
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
 * The remaining-repeats pair → one Wildflower `valueInteger`.
 *
 * @remarks
 * The count's own lift is read for its value only. Consumption is decided per
 * copy afterwards, so that each copy carrying that same number goes — not just
 * the one the count happened to be read from.
 */
const promoteRepeatsAvailable = (dispenseRequest: DispenseRequest): DispenseRequest =>
  pipe(
    liftRepeatsAvailable(dispenseRequest.modifierExtension),
    Option.map(({ value: count }) =>
      Struct.evolve(dispenseRequest, {
        modifierExtension: flow(
          Lift.drop(pipe(liftRepeatsAvailableV1, copyCarrying(count))),
          Lift.drop(pipe(liftRepeatsAvailableV2, copyCarrying(count)))
        ),
        extension: (extensions) => withRepeatsAvailable(extensions, count),
      })
    ),
    Option.getOrElse(() => dispenseRequest)
  )

export { promoteRepeatsAvailable }
