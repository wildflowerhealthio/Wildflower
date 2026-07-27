import { type Arbitrary, DateTime, type FastCheck, Option, ParseResult, Schema } from 'effect'

/**
 * A FHIR R4 `date` search-parameter value (§ search.html#date). The value
 * targets resource elements of type `date`, `dateTime`, `instant`, `Period`,
 * or `Timing`, and is one of two shapes on the wire:
 *
 * - **A prefixed instant** — a comparison {@link Prefix} (`eq`/`ne`/`gt`/`lt`/
 *   `ge`/`le`/`sa`/`eb`/`ap`) followed by a *complete* instant, e.g.
 *   `ge2026-07-27T14:27:30Z`. Decodes to `{ prefix, dateTime }` with the
 *   instant parsed to a {@link DateTime.Utc}.
 * - **A bare date literal** — a prefix-less `date`/`dateTime` of any FHIR
 *   precision (`2026`, `2026-07`, `2026-07-27`, or a full instant), e.g.
 *   `2026-07`. Decodes to the literal string **verbatim**.
 *
 * @remarks
 * The two shapes exist to keep partial precision honest. A `DateTime.Utc`
 * cannot represent "sometime in July 2026" without inventing a day, hour, and
 * so on, so a partial-precision value is only accepted **bare** and is carried
 * through as written — the server (HFS) interprets the implied range. A
 * comparison prefix, by contrast, is only meaningful against a definite point
 * in time, so the prefixed shape requires a complete instant (date, time, and
 * timezone) and rejects a partial value rather than widening it.
 *
 * Consequence: a *prefixed* partial-precision range such as FHIR's `ge2026`
 * (meaning "on or after the start of 2026") is not expressible directly —
 * spell it `ge2026-01-01T00:00:00Z`. Bare `ne`/`ap` on a partial value are
 * likewise not modelled. This narrowing is catalogued in
 * `fhir-r4/docs/Client Capabilities Reference.md`.
 */

/** FHIR search-parameter comparison prefixes valid on `date` parameters. */
const Prefix = Schema.Literal('eq', 'ne', 'gt', 'lt', 'ge', 'le', 'sa', 'eb', 'ap')
type Prefix = Schema.Schema.Type<typeof Prefix>

const PREFIXES = ['eq', 'ne', 'gt', 'lt', 'ge', 'le', 'sa', 'eb', 'ap'] as const
const isPrefix = (candidate: string): candidate is Prefix =>
  (PREFIXES as readonly string[]).includes(candidate)

/**
 * FHIR R4 `dateTime` grammar: a 4-digit year, optionally narrowed to
 * year-month, then full date, then a full time with mandatory timezone. This
 * is exactly the set of partial-or-complete literals a bare value may take.
 */
const FHIR_DATE_TIME =
  /^([0-9]([0-9]([0-9][1-9]|[1-9]0)|[1-9]00)|[1-9]000)(-(0[1-9]|1[0-2])(-(0[0-9]|[1-2][0-9]|3[0-1])(T([01][0-9]|2[0-3]):[0-5][0-9]:([0-5][0-9]|60)(\.[0-9]+)?(Z|(\+|-)((0[0-9]|1[0-3]):[0-5][0-9]|14:00)))?)?)?$/

/** The date-and-timezone-complete subset of {@link FHIR_DATE_TIME}: a FHIR
 * `instant`. The remainder after a prefix must match this so it round-trips
 * through a {@link DateTime.Utc} without any invented precision. */
const FHIR_INSTANT =
  /^([0-9]([0-9]([0-9][1-9]|[1-9]0)|[1-9]00)|[1-9]000)-(0[1-9]|1[0-2])-(0[0-9]|[1-2][0-9]|3[0-1])T([01][0-9]|2[0-3]):[0-5][0-9]:([0-5][0-9]|60)(\.[0-9]+)?(Z|(\+|-)((0[0-9]|1[0-3]):[0-5][0-9]|14:00))$/

/**
 * Bounded UTC-instant arbitrary shared by the prefixed shape and used to keep
 * generated instants inside FHIR's `[1000, 9999]` year window, so
 * {@link DateTime.formatIso} always emits a spec-valid, re-decodable string.
 * `1000-01-01T00:00:00Z` → -30610224000000; `9999-12-31T23:59:59.999Z` →
 * 253402300799999. */
const boundedInstant: Arbitrary.LazyArbitrary<DateTime.Utc> = (fc: typeof FastCheck) =>
  fc.integer({ min: -30610224000000, max: 253402300799999 }).map((ms) => DateTime.unsafeMake(ms))

/** Generator of bare `date`/`dateTime` literals at every FHIR precision. */
const bareDateLiteral: Arbitrary.LazyArbitrary<string> = (fc: typeof FastCheck) => {
  const year = fc.integer({ min: 1000, max: 9999 }).map(String)
  const month = fc.integer({ min: 1, max: 12 }).map((m) => String(m).padStart(2, '0'))
  const day = fc.integer({ min: 1, max: 28 }).map((d) => String(d).padStart(2, '0'))
  return fc.oneof(
    year,
    fc.tuple(year, month).map(([y, m]) => `${y}-${m}`),
    fc.tuple(year, month, day).map(([y, m, d]) => `${y}-${m}-${d}`),
    boundedInstant(fc).map((instant) => DateTime.formatIso(instant))
  )
}

const PrefixedInstant = Schema.Struct({
  prefix: Prefix,
  dateTime: Schema.DateTimeUtcFromSelf.annotations({ arbitrary: () => boundedInstant }),
})

const BareDateLiteral = Schema.String.pipe(
  Schema.pattern(FHIR_DATE_TIME),
  Schema.annotations({ arbitrary: () => bareDateLiteral })
)

const Decoded = Schema.Union(PrefixedInstant, BareDateLiteral)
type Decoded = Schema.Schema.Type<typeof Decoded>

/**
 * A FHIR `date` search-parameter value: a wire string decoded to a prefixed
 * {@link DateTime.Utc} or a bare, precision-preserving date literal. Encodes
 * back to the exact wire spelling — a bare literal verbatim, a prefixed
 * instant as `${prefix}${DateTime.formatIso(dateTime)}`.
 */
const DateSearchParam = Schema.transformOrFail(Schema.String, Decoded, {
  strict: true,
  decode: (wire, _options, ast) => {
    const candidate = wire.slice(0, 2)
    if (isPrefix(candidate)) {
      const rest = wire.slice(2)
      if (!FHIR_INSTANT.test(rest)) {
        return ParseResult.fail(
          new ParseResult.Type(
            ast,
            wire,
            `a prefixed date search value must be a complete instant (date, time, and timezone); got "${rest}"`
          )
        )
      }
      return Option.match(DateTime.make(rest), {
        onNone: () =>
          ParseResult.fail(new ParseResult.Type(ast, wire, `unparseable instant "${rest}"`)),
        onSome: (dateTime) => ParseResult.succeed({ prefix: candidate, dateTime }),
      })
    }
    return ParseResult.decodeUnknown(BareDateLiteral)(wire)
  },
  encode: (decoded) =>
    ParseResult.succeed(
      typeof decoded === 'string'
        ? decoded
        : `${decoded.prefix}${DateTime.formatIso(decoded.dateTime)}`
    ),
}).annotations({
  // Names the wire schema in the generated OpenAPI so the host's `/docs`
  // Scalar page documents the `date` search parameter instead of showing an
  // opaque string. Pinned by `openapi-drift.test.ts`.
  identifier: 'FhirDateSearch',
  description:
    'A FHIR R4 date search value (§ search.html#date): a comparison prefix ' +
    '(eq/ne/gt/lt/ge/le/sa/eb/ap) in front of a complete instant, or a bare ' +
    'date/dateTime of any precision. See ' +
    'slices/emr/fhir-r4/docs/Client Capabilities Reference.md.',
})

export { DateSearchParam as Schema, Prefix, type Decoded as Type }
