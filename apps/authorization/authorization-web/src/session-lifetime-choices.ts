/**
 * The choices the grant detail's "Session lifetime" section offers for a
 * client's refresh limits, and how each reads. A choice holds the limit it
 * stands for, so a picked `<select>` value maps back to it without parsing.
 */

import type { RefreshPolicy } from '@wildflowerhealthio/authorization-core/domain'
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
 * `presets` and the `current` limit if it isn't one of them, shortest first.
 */
const limitChoices = (
  presets: readonly Duration.Duration[],
  current: Option.Option<Duration.Duration>,
  noLimitLabel: string
): readonly LimitChoice[] => {
  const unlisted = current.pipe(
    Option.filter((limit) => !presets.some((preset) => Equal.equals(preset, limit)))
  )
  const limits = Array.sort(Array.appendAll(presets, Option.toArray(unlisted)), Duration.Order)
  return [
    { value: '', label: noLimitLabel, limit: Option.none() },
    ...limits.map((limit) => ({
      value: choiceValue(Option.some(limit)),
      label: limitLabel(limit),
      limit: Option.some(limit),
    })),
  ]
}

/** The choices for the idle limit, keeping `current` among them. */
const idleTtlChoices = (current: Option.Option<Duration.Duration>): readonly LimitChoice[] =>
  limitChoices(IDLE_TTL_PRESETS, current, 'No limit')

/** The choices for the maximum lifetime, keeping `current` among them. */
const maxTtlChoices = (current: Option.Option<Duration.Duration>): readonly LimitChoice[] =>
  limitChoices(MAX_TTL_PRESETS, current, 'No limit (365 days at most)')

/** The limit the choice with `value` stands for, if one does. */
const limitOfChoice = (
  choices: readonly LimitChoice[],
  value: string
): Option.Option<Option.Option<Duration.Duration>> =>
  Array.findFirst(choices, (choice) => choice.value === value).pipe(
    Option.map((choice) => choice.limit)
  )

/** Whether two policies say the same thing. */
const isSamePolicy = (left: RefreshPolicy.Type, right: RefreshPolicy.Type): boolean =>
  Equal.equals(left.idleTtl, right.idleTtl) &&
  Equal.equals(left.maxTtl, right.maxTtl) &&
  left.endsWithBrowserSession === right.endsWithBrowserSession

export {
  choiceValue,
  idleTtlChoices,
  isSamePolicy,
  limitLabel,
  limitOfChoice,
  maxTtlChoices,
  type LimitChoice,
}
