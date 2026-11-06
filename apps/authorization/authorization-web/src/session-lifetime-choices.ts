/**
 * The choices the grant detail's "Session lifetime" section offers for a
 * client's refresh limits, and how each reads. A choice holds the limit it
 * stands for, so a picked `<select>` value maps back to it without parsing.
 */

import { Array, Duration, Equal, Option } from 'effect'

/** One option of a limit's `<select>`. */
interface LimitChoice {
  /** The `<select>` value: the limit in seconds, or `''` for no limit. */
  readonly value: string
  readonly label: string
  readonly limit: Option.Option<Duration.Duration>
}

/** The idle limits offered, shortest first. */
const IDLE_TTL_PRESETS: readonly Duration.Duration[] = [
  Duration.minutes(15),
  Duration.minutes(30),
  Duration.hours(1),
  Duration.hours(2),
  Duration.hours(8),
  Duration.days(1),
  Duration.days(7),
  Duration.days(30),
]

/** The maximum lifetimes offered, shortest first. */
const MAX_TTL_PRESETS: readonly Duration.Duration[] = [
  Duration.days(1),
  Duration.days(7),
  Duration.days(30),
  Duration.days(90),
]

/** `count` of `unit`, pluralised. */
const countOf = (count: number, unit: string): string => `${count} ${unit}${count === 1 ? '' : 's'}`

/** A limit as the Owner reads it, in the largest whole unit: `30 minutes`, `2 hours`, `7 days`. */
const limitLabel = (limit: Duration.Duration): string => {
  const seconds = Duration.toSeconds(limit)
  if (seconds % 86_400 === 0) return countOf(seconds / 86_400, 'day')
  if (seconds % 3_600 === 0) return countOf(seconds / 3_600, 'hour')
  if (seconds % 60 === 0) return countOf(seconds / 60, 'minute')
  return countOf(seconds, 'second')
}

/** The `<select>` value standing for `limit`. */
const choiceValue = (limit: Option.Option<Duration.Duration>): string =>
  limit.pipe(
    Option.map((some) => String(Duration.toSeconds(some))),
    Option.getOrElse(() => '')
  )

/**
 * The choices for one limit: no limit, labelled `noLimitLabel`, then the
 * `presets` and each of the `kept` limits that isn't one of them, shortest
 * first.
 */
const limitChoices = (
  presets: readonly Duration.Duration[],
  kept: readonly Option.Option<Duration.Duration>[],
  noLimitLabel: string
): readonly LimitChoice[] => {
  const limits = Array.sort(
    Array.dedupeWith(Array.appendAll(presets, Array.getSomes(kept)), Equal.equals),
    Duration.Order
  )
  return [
    { value: '', label: noLimitLabel, limit: Option.none() },
    ...limits.map((limit) => ({
      value: choiceValue(Option.some(limit)),
      label: limitLabel(limit),
      limit: Option.some(limit),
    })),
  ]
}

/**
 * The choices for the idle limit, keeping each of `kept` (the stored limit and
 * the one in the form) among them.
 */
const idleTtlChoices = (
  ...kept: readonly Option.Option<Duration.Duration>[]
): readonly LimitChoice[] => limitChoices(IDLE_TTL_PRESETS, kept, 'No limit')

/**
 * The choices for the maximum lifetime, keeping each of `kept` (the stored
 * limit and the one in the form) among them.
 */
const maxTtlChoices = (
  ...kept: readonly Option.Option<Duration.Duration>[]
): readonly LimitChoice[] => limitChoices(MAX_TTL_PRESETS, kept, 'No limit (365 days at most)')

/** The limit the choice with `value` stands for, if one does. */
const limitOfChoice = (
  choices: readonly LimitChoice[],
  value: string
): Option.Option<Option.Option<Duration.Duration>> =>
  Array.findFirst(choices, (choice) => choice.value === value).pipe(
    Option.map((choice) => choice.limit)
  )

export { choiceValue, idleTtlChoices, limitLabel, limitOfChoice, maxTtlChoices, type LimitChoice }
