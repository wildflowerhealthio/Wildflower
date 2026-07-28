import { type Arbitrary, DateTime, type FastCheck, Option, ParseResult, Schema } from 'effect'

/**
 * A FHIR R4 `date` search-parameter value (§ search.html#date). The value
 * targets resource elements of type `date`, `dateTime`, `instant`, `Period`,
 * or `Timing`.
 *
 * Per the spec, a `date` search is **intrinsically a match against a period**,
 * whatever the precision of the value and whatever the type of the element it
 * is compared to. This schema therefore decodes every value — prefixed or not,
 * complete or partial — to the same shape: a comparison {@link Prefix}, the
 * literal exactly as authored, and the closed interval that literal denotes.
 *
 * - `ge2026` →
 *   `{ prefix: some('ge'), value: '2026', lowerBound: 2026-01-01T00:00:00.000Z, upperBound: 2026-12-31T23:59:59.999Z }`
 * - `2026-07` →
 *   `{ prefix: none(), value: '2026-07', lowerBound: 2026-07-01T00:00:00.000Z, upperBound: 2026-07-31T23:59:59.999Z }`
 *
 * @remarks
 * The bounds follow the spec's rule for filling unspecified levels: the lower
 * bound takes the lowest possible value of every level the literal omits (first
 * month, first day, zero-filled time), the upper bound the highest (last month,
 * last day *allowing for leap years*, `23:59:59.999`). `value` is kept verbatim
 * alongside them so no precision is invented on the wire — a `date=2026-07`
 * stays `2026-07` and lets the server apply its own range interpretation.
 *
 * `prefix` is `None` when the wire carried none, which per § search.html#prefix
 * means `eq`; read it as `Option.getOrElse(prefix, () => 'eq' as const)`. The
 * absence is kept rather than materialized so encoding reproduces the query
 * byte for byte — `SearchParams` property-tests that no parameter is silently
 * normalized on its way to the server.
 */

/** FHIR search-parameter comparison prefixes valid on `date` parameters. */
const Prefix = Schema.Literal('eq', 'ne', 'gt', 'lt', 'ge', 'le', 'sa', 'eb', 'ap')
type Prefix = Schema.Schema.Type<typeof Prefix>

const PREFIXES = ['eq', 'ne', 'gt', 'lt', 'ge', 'le', 'sa', 'eb', 'ap'] as const
const isPrefix = (candidate: string): candidate is Prefix =>
  (PREFIXES as readonly string[]).includes(candidate)

/**
 * FHIR R4 `dateTime` grammar as § search.html#date relaxes it: a 4-digit year,
 * optionally narrowed to year-month, then full date, then a time with a
 * mandatory timezone. Seconds are **optional** — the search section departs
 * from the XML Schema dateTime type here ("Time can consist of hours and
 * minutes with no seconds") — while a timezone stays required once a time is
 * present, as in the underlying datatype.
 */
const FHIR_DATE_TIME =
  /^([0-9]([0-9]([0-9][1-9]|[1-9]0)|[1-9]00)|[1-9]000)(-(0[1-9]|1[0-2])(-(0[1-9]|[1-2][0-9]|3[0-1])(T([01][0-9]|2[0-3]):[0-5][0-9](:([0-5][0-9]|60)(\.[0-9]+)?)?(Z|(\+|-)((0[0-9]|1[0-3]):[0-5][0-9]|14:00)))?)?)?$/

/** Trailing `Z` or `±hh:mm` of a time-bearing literal. */
const TIMEZONE = /(?:Z|[+-][0-9]{2}:[0-9]{2})$/

const isLeapYear = (year: number): boolean =>
  (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const

/** Last day of `month` (1-based) in `year`, allowing for leap years. */
const lastDayOfMonth = (year: number, month: number): number =>
  month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1]

const twoDigits = (value: number): string => String(value).padStart(2, '0')

/**
 * The bounds of a `hh:mm`, `hh:mm:ss`, or `hh:mm:ss.fff` clock reading, once
 * every level it leaves unspecified is filled in from the bottom and the top.
 */
const clockBounds = (clock: string): { readonly lower: string; readonly upper: string } => {
  if (clock.length === 5) return { lower: `${clock}:00.000`, upper: `${clock}:59.999` }
  // A leap second has no representation in POSIX time, so both bounds collapse
  // onto the last representable instant of the minute it belongs to.
  if (clock.slice(6, 8) === '60') {
    const lastInstant = `${clock.slice(0, 6)}59.999`
    return { lower: lastInstant, upper: lastInstant }
  }
  if (clock.length === 8) return { lower: `${clock}.000`, upper: `${clock}.999` }
  return { lower: clock, upper: clock }
}

const boundsFrom = (
  lower: string,
  upper: string
): Option.Option<{ readonly lowerBound: DateTime.Utc; readonly upperBound: DateTime.Utc }> =>
  Option.zipWith(DateTime.make(lower), DateTime.make(upper), (lowerBound, upperBound) => ({
    lowerBound,
    upperBound,
  }))

/**
 * The period a `date`/`dateTime` literal denotes: its earliest instant through
 * its latest. `None` only for a literal outside {@link FHIR_DATE_TIME}, whose
 * shape the caller is expected to have checked first.
 */
const periodOf = (
  literal: string
): Option.Option<{ readonly lowerBound: DateTime.Utc; readonly upperBound: DateTime.Utc }> => {
  const year = literal.slice(0, 4)
  if (literal.length === 4) {
    return boundsFrom(`${year}-01-01T00:00:00.000Z`, `${year}-12-31T23:59:59.999Z`)
  }

  const month = literal.slice(5, 7)
  if (literal.length === 7) {
    const lastDay = twoDigits(lastDayOfMonth(Number(year), Number(month)))
    return boundsFrom(
      `${year}-${month}-01T00:00:00.000Z`,
      `${year}-${month}-${lastDay}T23:59:59.999Z`
    )
  }

  // Dates carry no timezone, and § search.html#date says none should be
  // considered for them, so a date-only period is bounded in UTC.
  const date = literal.slice(0, 10)
  if (literal.length === 10) {
    return boundsFrom(`${date}T00:00:00.000Z`, `${date}T23:59:59.999Z`)
  }

  const time = literal.slice(11)
  const zoneAt = time.search(TIMEZONE)
  if (zoneAt < 0) return Option.none()
  const { lower, upper } = clockBounds(time.slice(0, zoneAt))
  const zone = time.slice(zoneAt)
  return boundsFrom(`${date}T${lower}${zone}`, `${date}T${upper}${zone}`)
}

/**
 * Generator of `date`/`dateTime` literals at every FHIR precision, inside the
 * `[1000, 9999]` year window so {@link DateTime.formatIso} always emits a
 * spec-valid, re-decodable string.
 */
const dateLiteral: Arbitrary.LazyArbitrary<string> = (fc: typeof FastCheck) => {
  const year = fc.integer({ min: 1000, max: 9999 }).map(String)
  const month = fc.integer({ min: 1, max: 12 }).map(twoDigits)
  const day = fc.integer({ min: 1, max: 28 }).map(twoDigits)
  const hourMinute = fc
    .tuple(fc.integer({ min: 0, max: 23 }), fc.integer({ min: 0, max: 59 }))
    .map(([h, m]) => `${twoDigits(h)}:${twoDigits(m)}`)
  const date = fc.tuple(year, month, day).map(([y, m, d]) => `${y}-${m}-${d}`)
  return fc.oneof(
    year,
    fc.tuple(year, month).map(([y, m]) => `${y}-${m}`),
    date,
    fc.tuple(date, hourMinute).map(([d, hm]) => `${d}T${hm}Z`),
    fc
      .integer({ min: -30610224000000, max: 253402300799999 })
      .map((ms) => DateTime.formatIso(DateTime.unsafeMake(ms)))
  )
}

const decodedArbitrary: Arbitrary.LazyArbitrary<Decoded> = (fc: typeof FastCheck) =>
  fc
    .tuple(
      fc.oneof(fc.constant(Option.none<Prefix>()), fc.constantFrom(...PREFIXES).map(Option.some)),
      dateLiteral(fc)
    )
    .map(([prefix, value]) => ({
      prefix,
      value,
      // Total by construction: every literal the generator emits is in-grammar.
      ...Option.getOrThrow(periodOf(value)),
    }))

const DateSearchValue = Schema.Struct({
  prefix: Schema.OptionFromSelf(Prefix),
  value: Schema.String.pipe(Schema.pattern(FHIR_DATE_TIME)),
  lowerBound: Schema.DateTimeUtcFromSelf,
  upperBound: Schema.DateTimeUtcFromSelf,
}).annotations({ arbitrary: () => decodedArbitrary })

type Decoded = Schema.Schema.Type<typeof DateSearchValue>

/**
 * A FHIR `date` search-parameter value: a wire string decoded to an optional
 * comparison prefix, the literal as authored, and the period that literal
 * denotes. Encodes back to the exact wire spelling.
 */
const DateSearchParam = Schema.transformOrFail(Schema.String, DateSearchValue, {
  strict: true,
  decode: (wire, _options, ast) => {
    const candidate = wire.slice(0, 2)
    const prefixed = isPrefix(candidate)
    // Absence is kept, not defaulted to the implied `eq`, so encode can
    // reproduce the query exactly as the caller spelled it.
    const prefix = prefixed ? Option.some(candidate) : Option.none<Prefix>()
    const value = prefixed ? wire.slice(2) : wire

    if (!FHIR_DATE_TIME.test(value)) {
      return ParseResult.fail(
        new ParseResult.Type(
          ast,
          wire,
          `a date search value must be a year, year-month, date, or date-and-time with a timezone; got "${value}"`
        )
      )
    }

    return Option.match(periodOf(value), {
      onNone: () =>
        ParseResult.fail(
          new ParseResult.Type(ast, wire, `unrepresentable date search value "${value}"`)
        ),
      onSome: (period) => ParseResult.succeed({ prefix, value, ...period }),
    })
  },
  encode: (decoded) =>
    ParseResult.succeed(`${Option.getOrElse(decoded.prefix, () => '')}${decoded.value}`),
}).annotations({
  // Names the wire schema in the generated OpenAPI so the host's `/docs`
  // Scalar page documents the `date` search parameter instead of showing an
  // opaque string. Pinned by `openapi-drift.test.ts`.
  identifier: 'FhirDateSearch',
  description:
    'A FHIR R4 date search value (§ search.html#date): an optional comparison ' +
    'prefix (eq/ne/gt/lt/ge/le/sa/eb/ap) in front of a date or dateTime of any ' +
    'precision, e.g. ge2026, 2026-07, or lt2026-07-27T14:27:30Z. The value ' +
    'denotes the period its precision implies. See ' +
    'slices/emr/fhir-r4/docs/Client Capabilities Reference.md.',
})

export { DateSearchParam as Schema, Prefix, type Decoded as Type }
