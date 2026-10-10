import { Array as Arr, DateTime, Option, Order, Schema, String as Str } from 'effect'

import {
  OrNullAsOptional,
  StructNoContext,
  mutableEncoded,
} from '@wildflowerhealthio/kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import { registerDatatypeSchema } from '../base/datatype-registry.ts'
import * as Element from '../base/element.ts'
import * as Period from './period.ts'

const HumanNameStruct = mutableEncoded(
  StructNoContext({
    ...Element.fields,
    family: OrNullAsOptional(Schema.String),
    given: Schema.optionalWith(mutableEncoded(Schema.Array(Schema.String)), {
      default: () => [] as readonly string[],
    }),
    period: OrNullAsOptional(Schema.suspend(() => Period.Schema)),
    prefix: Schema.optionalWith(mutableEncoded(Schema.Array(Schema.String)), {
      default: () => [] as readonly string[],
    }),
    suffix: Schema.optionalWith(mutableEncoded(Schema.Array(Schema.String)), {
      default: () => [] as readonly string[],
    }),
    text: OrNullAsOptional(Schema.String),
    use: OrNullAsOptional(
      Schema.Union(
        Schema.Literal('usual'),
        Schema.Literal('official'),
        Schema.Literal('temp'),
        Schema.Literal('nickname'),
        Schema.Literal('anonymous'),
        Schema.Literal('old'),
        Schema.Literal('maiden')
      )
    ),
  })
)

const HumanNameSchema: Schema.Schema<typeof HumanNameStruct.Type, FhirR4.HumanName, never> =
  HumanNameStruct

registerDatatypeSchema('HumanName', HumanNameSchema)

/**
 * The fields a name's display text is read from. A decoded `HumanName` has them
 * (`null` when absent, `given` defaulting to `[]`), and so does a name decoded
 * loosely from raw wire JSON (where absence is `undefined` and `period.end` is
 * still a string), so a reader working on either picks and renders a name by
 * the same rule.
 */
interface Displayable {
  readonly use?: string | null | undefined
  readonly given?: readonly string[] | null | undefined
  readonly family?: string | null | undefined
  readonly text?: string | null | undefined
  readonly period?:
    | { readonly end?: DateTime.DateTime | string | null | undefined }
    | null
    | undefined
}

/** Uses that name who the person was, not who they are. */
const FORMER_USES: ReadonlySet<string> = new Set(['old', 'maiden'])

/**
 * How strongly a name's `use` claims to be the one to show: lower wins.
 * `official`, then `usual`, then a name with no `use` at all (most records
 * mark none), then the uses that say the name is not the everyday one —
 * `nickname`, `temp`, `anonymous`.
 */
const useRank = (use: string | null | undefined): number => {
  if (use === 'official') return 0
  if (use === 'usual') return 1
  if (use === null || use === undefined) return 2
  return 3
}

/** `name` as `given family` (each part trimmed, blanks dropped), else its trimmed `text`. */
const renderName = (name: Displayable): string => {
  const parts = [...(name.given ?? []), name.family ?? '']
    .map((part) => part.trim())
    .filter(Str.isNonEmpty)
  return parts.length > 0 ? parts.join(' ') : (name.text ?? '').trim()
}

/** A FHIR `date` / partial `dateTime`: a year, a year-month, or a full date. */
const PARTIAL_DATE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/u

/** The span a partial date covers: a day, a month, or a year. */
const precisionOf = (
  month: string | undefined,
  day: string | undefined
): Partial<DateTime.DateTime.PartsForMath> => {
  if (day !== undefined) return { days: 1 }
  if (month !== undefined) return { months: 1 }
  return { years: 1 }
}

/**
 * Whether a `period.end` written as `end` has passed at `now`, or `None` when
 * `end` does not parse as a date.
 *
 * @remarks
 * A FHIR `Period.end` is inclusive to its precision: `2024-06-01` runs to the
 * end of that day, `2020-05` to the end of May, `2020` to the end of the year.
 * So a date or partial date has passed once `now` reaches the start of the
 * next day, month or year (taken in UTC); a full `dateTime` has passed once
 * `now` is after it.
 */
const hasPassed = (end: string, now: DateTime.DateTime): Option.Option<boolean> => {
  const partial = PARTIAL_DATE.exec(end)
  if (partial === null)
    return Option.map(DateTime.make(end), (instant) => DateTime.lessThan(instant, now))
  const [, year, month, day] = partial
  const start = DateTime.make(`${year}-${month ?? '01'}-${day ?? '01'}T00:00:00Z`)
  const precision = precisionOf(month, day)
  return Option.map(start, (periodStart) =>
    DateTime.lessThanOrEqualTo(DateTime.add(periodStart, precision), now)
  )
}

/**
 * Whether `name`'s period has ended by `now`. No end, or one that does not parse
 * as a date, is not taken as ended. A decoded `DateTime` end is an instant — the
 * decode has already dropped the precision it was written to.
 */
const hasEndedAt = (name: Displayable, now: DateTime.DateTime): boolean => {
  const end = name.period?.end
  if (end === null || end === undefined) return false
  if (DateTime.isDateTime(end)) return DateTime.lessThan(end, now)
  return Option.getOrElse(hasPassed(end, now), () => false)
}

/** Whether `name` is still in use at `now`: not a former name, and not ended by `now`. */
const isCurrentAt =
  (now: DateTime.DateTime) =>
  (name: Displayable): boolean =>
    !FORMER_USES.has(name.use ?? '') && !hasEndedAt(name, now)

/** One name alongside what it renders to. */
interface RenderedName {
  readonly name: Displayable
  readonly text: string
}

const byUseRank: Order.Order<RenderedName> = Order.mapInput(
  Order.number,
  (rendered: RenderedName) => useRank(rendered.name.use)
)

/**
 * The text to show for a person with `names` — the name they go by now,
 * rendered as `given family` (else its `text`) — or `null` when no name
 * renders to anything.
 *
 * @param names - The person's names in record order, e.g. `Patient.name`
 * @param now - The instant "current" is judged at; defaults to the clock
 * @returns The chosen name's text, trimmed and single-spaced, or `null`
 *
 * @remarks
 * A person's record can carry several names, and the first is not always the
 * one to show: a record that kept a maiden name first would otherwise greet the
 * person by it. So the choice runs in three steps:
 *
 * 1. Every name is rendered — its non-blank `given` parts and `family`, each
 *    trimmed and joined by single spaces, else its trimmed `text` — and a name
 *    that renders blank is never chosen.
 * 2. Of the rest, a name still in use at `now` is preferred: not `old` or
 *    `maiden`, and without a `period.end` that has passed — an `end` counts to
 *    the end of the day, month or year it names, and one that does not parse
 *    as a date is not taken as ended. Among those, `official` beats `usual`
 *    beats a name with no `use` beats `nickname`, `temp` and `anonymous`, and
 *    record order breaks a tie.
 * 3. When no name is current, the first that renders in record order is shown
 *    anyway: a record whose only name is `old` still names someone.
 *
 * `now` is a parameter so the period cut-off is testable; a caller that is
 * showing the name to someone today omits it.
 */
const displayName = (
  names: readonly Displayable[],
  now: DateTime.DateTime = DateTime.unsafeNow()
): string | null => {
  const rendered = names
    .map((name): RenderedName => ({ name, text: renderName(name) }))
    .filter((candidate) => Str.isNonEmpty(candidate.text))
  const isCurrent = isCurrentAt(now)
  const current = Arr.sort(
    rendered.filter((candidate) => isCurrent(candidate.name)),
    byUseRank
  )
  return (current[0] ?? rendered[0])?.text ?? null
}

export { displayName, HumanNameSchema as Schema }
export type { Displayable }
