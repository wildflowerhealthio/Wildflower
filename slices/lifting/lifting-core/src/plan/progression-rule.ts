import { type Brand, type Either, Option, type ParseResult, pipe, Schema } from 'effect'
import { Extension, narrowFields, WildflowerExtension } from 'fhir-r4/data-types'

import {
  type ArrayFilter,
  filterArrayWithOneMatchingElement,
} from '../internal/filter-array-with-one-matching-element.ts'
import { guaranteed } from '../internal/guaranteed.ts'
import { narrowedFrom } from '../internal/narrowed-from.ts'
import * as Load from '../load/load.ts'

/**
 * The sub-extension urls nested inside a
 * {@link WildflowerExtension.LiftingProgression} extension, one per rule
 * parameter.
 *
 * @remarks
 * Relative names, not absolute urls: FHIR scopes a complex extension's
 * sub-extension `url` to its parent, so these mean something only inside a
 * `LiftingProgression` extension. Persisted wire format — append, don't rename.
 */
const Part = {
  /**
   * The unit the rule's amounts are in, as a `valueString` holding its UCUM
   * code (`[lb_av]` or `kg`) — a string, not a `valueCode`, which fhir-r4
   * leaves unregistered.
   */
  Unit: 'unit',
  /** Added to the load after a successful workout, as a `valueDecimal` `> 0`. */
  Increment: 'increment',
  /** Consecutive failed workouts at one load that trigger a deload, as a positive `valueInteger`. */
  FailuresBeforeDeload: 'failuresBeforeDeload',
  /** The fraction of the load a deload takes off, as a `valueDecimal` strictly between 0 and 1. */
  DeloadFraction: 'deloadFraction',
  /**
   * The lightest load a deload may reach, as a `valueDecimal` `≥ 0`. For a
   * barbell lift it is the empty bar (45 lb, or 20 kg).
   */
  MinimumLoad: 'minimumLoad',
  /**
   * The smallest change the equipment can make to the load, as a
   * `valueDecimal` `> 0`. For a barbell it is one pair of the smallest common
   * plates (2 × 2.5 lb).
   */
  LoadStep: 'loadStep',
} as const

/** One of the {@link Part} names. */
type PartName = (typeof Part)[keyof typeof Part]

/** A finite number `> 0`. */
const PositiveDecimal = Schema.Finite.pipe(Schema.positive())

/**
 * What each part's sub-extension must carry: its `value[x]` slot, in range.
 * The sub-extension is already a decoded `Extension`, so only that slot is
 * checked.
 */
const PART_SCHEMAS = {
  unit: Schema.Struct({ valueString: Load.UnitSchema }),
  increment: Schema.Struct({ valueDecimal: PositiveDecimal }),
  failuresBeforeDeload: Schema.Struct({ valueInteger: Schema.Int.pipe(Schema.positive()) }),
  deloadFraction: Schema.Struct({
    valueDecimal: Schema.Number.pipe(Schema.greaterThan(0), Schema.lessThan(1)),
  }),
  minimumLoad: Schema.Struct({ valueDecimal: Schema.Finite.pipe(Schema.nonNegative()) }),
  loadStep: Schema.Struct({ valueDecimal: PositiveDecimal }),
} as const satisfies Record<PartName, Schema.Schema.AnyNoContext>

/** Filters a rule's sub-extensions to hold exactly one at `part`, its value in range. */
const filterArrayWithOneProgressionRulePart = (part: PartName): ArrayFilter<Extension.Type> =>
  filterArrayWithOneMatchingElement({
    matches: Extension.hasUrl(part),
    schema: PART_SCHEMAS[part],
    expected: `"${part}" part`,
  })

/**
 * How one exercise's load moves between workouts, as FHIR carries it: a
 * {@link WildflowerExtension.LiftingProgression} extension narrowed to exactly
 * one sub-extension per {@link Part}, each in range. Up by the increment after
 * a success; after enough consecutive failed workouts at one load, down by
 * the deload fraction, rounded down to a multiple of the load step and never
 * below the minimum load. Every amount is in the rule's unit, and only a load
 * in that unit progresses by this rule.
 */
interface Type extends Omit<Extension.Type, 'url'>, Brand.Brand<'ProgressionRule'> {
  /** Always the `LiftingProgression` url. */
  readonly url: typeof WildflowerExtension.LiftingProgression
}

/**
 * Decodes an `Extension` into a {@link Type} — fails, naming the part, when
 * it is not at the `LiftingProgression` url, or a part is missing, repeated,
 * or out of range.
 */
const ProgressionRuleSchema: Schema.Schema<Type, Extension.Type> = narrowedFrom<Extension.Type>()(
  narrowFields(Schema.typeSchema(Extension.Schema), {
    url: Schema.Literal(WildflowerExtension.LiftingProgression),
    extension: Schema.Array(Schema.typeSchema(Extension.Schema)).pipe(
      filterArrayWithOneProgressionRulePart(Part.Unit),
      filterArrayWithOneProgressionRulePart(Part.Increment),
      filterArrayWithOneProgressionRulePart(Part.FailuresBeforeDeload),
      filterArrayWithOneProgressionRulePart(Part.DeloadFraction),
      filterArrayWithOneProgressionRulePart(Part.MinimumLoad),
      filterArrayWithOneProgressionRulePart(Part.LoadStep)
    ),
  }).pipe(Schema.brand('ProgressionRule'))
)

/**
 * A progression rule: every amount in `unit`.
 *
 * @returns The rule; or a `ParseError` naming each parameter out of range —
 *   `increment` and `loadStep` must be finite and positive,
 *   `failuresBeforeDeload` a positive integer, `deloadFraction` strictly
 *   between 0 and 1, `minimumLoad` finite and non-negative
 */
const make = (rule: {
  readonly unit: Load.Unit
  readonly increment: number
  readonly failuresBeforeDeload: number
  readonly deloadFraction: number
  readonly minimumLoad: number
  readonly loadStep: number
}): Either.Either<Type, ParseResult.ParseError> =>
  Schema.decodeEither(ProgressionRuleSchema, { errors: 'all' })({
    ...Extension.emptyAt(WildflowerExtension.LiftingProgression),
    extension: [
      { ...Extension.emptyAt(Part.Unit), valueString: rule.unit },
      { ...Extension.emptyAt(Part.Increment), valueDecimal: rule.increment },
      { ...Extension.emptyAt(Part.FailuresBeforeDeload), valueInteger: rule.failuresBeforeDeload },
      { ...Extension.emptyAt(Part.DeloadFraction), valueDecimal: rule.deloadFraction },
      { ...Extension.emptyAt(Part.MinimumLoad), valueDecimal: rule.minimumLoad },
      { ...Extension.emptyAt(Part.LoadStep), valueDecimal: rule.loadStep },
    ],
  })

/** The one sub-extension at `part` of `rule`, as `schema` reads it. */
const partOf = <A>(read: {
  readonly rule: Type
  readonly part: PartName
  readonly schema: Schema.Schema<A>
}): A =>
  guaranteed(
    pipe(
      Extension.onlyAt(read.rule.extension, read.part),
      Option.flatMap(Schema.validateOption(read.schema))
    )
  )

/** The unit the rule's amounts are in, and the only unit a load it moves may be in. */
const unitOf = (rule: Type): Load.Unit =>
  partOf({ rule, part: Part.Unit, schema: PART_SCHEMAS.unit }).valueString

/** Added to the load after a successful workout. */
const incrementOf = (rule: Type): number =>
  partOf({ rule, part: Part.Increment, schema: PART_SCHEMAS.increment }).valueDecimal

/** Consecutive failed workouts at one load that trigger a deload. */
const failuresBeforeDeloadOf = (rule: Type): number =>
  partOf({ rule, part: Part.FailuresBeforeDeload, schema: PART_SCHEMAS.failuresBeforeDeload })
    .valueInteger

/** The fraction of the load a deload takes off. */
const deloadFractionOf = (rule: Type): number =>
  partOf({ rule, part: Part.DeloadFraction, schema: PART_SCHEMAS.deloadFraction }).valueDecimal

/** The lightest load a deload may reach. */
const minimumLoadOf = (rule: Type): number =>
  partOf({ rule, part: Part.MinimumLoad, schema: PART_SCHEMAS.minimumLoad }).valueDecimal

/** The smallest change the equipment can make to the load. */
const loadStepOf = (rule: Type): number =>
  partOf({ rule, part: Part.LoadStep, schema: PART_SCHEMAS.loadStep }).valueDecimal

/**
 * The loads `rule` moves: a {@link Load.Type} in the rule's unit — a rule
 * never converts between pounds and kilograms.
 */
const movableLoadSchema = (rule: Type): Schema.Schema<Load.Type> =>
  Schema.typeSchema(Load.Schema).pipe(
    Schema.filter((load) => Load.unitOf(load) === unitOf(rule), {
      message: (issue) =>
        `expected a load in ${unitOf(rule)}, the unit the rule moves, actual ${JSON.stringify(issue.actual)}`,
    })
  )

/**
 * The loads a lifter may start `rule`'s exercise at: {@link movableLoadSchema},
 * and at or above the rule's minimum load.
 */
const startingLoadSchema = (rule: Type): Schema.Schema<Load.Type> =>
  movableLoadSchema(rule).pipe(
    Schema.filter((load) => Load.valueOf(load) >= minimumLoadOf(rule), {
      message: () => `expected a load of at least ${minimumLoadOf(rule)} ${unitOf(rule)}`,
    })
  )

export {
  deloadFractionOf,
  failuresBeforeDeloadOf,
  incrementOf,
  loadStepOf,
  make,
  minimumLoadOf,
  movableLoadSchema,
  Part,
  ProgressionRuleSchema as Schema,
  startingLoadSchema,
  unitOf,
}
export type { PartName, Type }
