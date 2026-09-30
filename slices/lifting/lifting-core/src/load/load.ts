import { type Either, type Brand, type ParseResult, Schema } from 'effect'
import { Code, narrowFields, Quantity } from 'fhir-r4/data-types'

import { narrowedFrom } from '../internal/narrowed-from.ts'

/** The UCUM system every load `Quantity` is coded in. */
const UCUM_SYSTEM = 'http://unitsofmeasure.org'

/** The units a load is lifted in. Persisted wire format — append, don't rename. */
const UnitSchema = Schema.Literal('lb', 'kg')

/** A unit a load is lifted in: `lb` or `kg`. */
type Unit = typeof UnitSchema.Type

/** The UCUM code each unit is written as: the avoirdupois pound, the kilogram. */
const UCUM_CODE_OF_UNIT = { lb: '[lb_av]', kg: 'kg' } as const satisfies Record<Unit, string>

/** A load's UCUM `code`: `[lb_av]` or `kg`, as a FHIR `code`. */
const UcumCodeSchema = Schema.Literal(UCUM_CODE_OF_UNIT.lb, UCUM_CODE_OF_UNIT.kg).pipe(
  Schema.brand('code')
)

/**
 * A load on the bar: a FHIR `Quantity` narrowed to a finite, non-negative
 * `value` in UCUM `[lb_av]` or `kg`, with no `comparator`.
 *
 * @remarks
 * Still a `Quantity` — it is written wherever one is — so the brand records
 * that it came through {@link Schema} or {@link make}. `unit` (the display
 * unit) is not read: the unit is the UCUM `code`.
 */
interface Type
  extends Omit<Quantity.Type, 'value' | 'system' | 'code' | 'comparator'>, Brand.Brand<'Load'> {
  /** The amount, finite and `≥ 0`. */
  readonly value: number
  /** Always UCUM. */
  readonly system: typeof UCUM_SYSTEM
  /** `[lb_av]` or `kg`; see {@link unitOf}. */
  readonly code: typeof UcumCodeSchema.Type
  /** Always absent: a load is exact. */
  readonly comparator: null
}

/**
 * Decodes a `Quantity` into a {@link Type} — fails, naming the field, on a
 * value that is missing, negative or not finite, a system other than UCUM, a
 * code other than `[lb_av]` or `kg`, or any comparator.
 *
 * @remarks
 * A `value[x]` `Quantity` slot types as `any` on a decoded resource, so
 * decode such a slot with `Schema.decodeUnknown` rather than reading it
 * unchecked.
 */
const LoadSchema: Schema.Schema<Type, Quantity.Type> = narrowedFrom<Quantity.Type>()(
  narrowFields(Schema.typeSchema(Quantity.Schema), {
    value: Schema.Finite.pipe(Schema.nonNegative()),
    system: Schema.Literal(UCUM_SYSTEM),
    code: UcumCodeSchema,
    comparator: Schema.Null,
  }).pipe(Schema.brand('Load'))
)

/**
 * A load of `value` in `unit`.
 *
 * @returns The load; or a `ParseError` when `value` is negative or not finite
 */
const make = (load: {
  readonly value: number
  readonly unit: Unit
}): Either.Either<Type, ParseResult.ParseError> =>
  Schema.decodeEither(LoadSchema, { errors: 'all' })({
    id: null,
    extension: [],
    value: load.value,
    unit: load.unit,
    system: UCUM_SYSTEM,
    code: Code.make(UCUM_CODE_OF_UNIT[load.unit]),
    comparator: null,
  })

/** The amount of a load, in {@link unitOf} it. */
const valueOf = (load: Type): number => load.value

/** The unit a load is in, from its UCUM code. */
const unitOf = (load: Type): Unit => (load.code === UCUM_CODE_OF_UNIT.kg ? 'kg' : 'lb')

/** The same load at another value, in the same unit. */
const withValue = (load: Type, value: number): Either.Either<Type, ParseResult.ParseError> =>
  make({ value, unit: unitOf(load) })

export { LoadSchema as Schema, make, UnitSchema, unitOf, valueOf, withValue }
export type { Type, Unit }
