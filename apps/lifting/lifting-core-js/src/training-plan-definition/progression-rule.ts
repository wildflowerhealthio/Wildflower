import {
  Extension,
  narrowFields,
  WildflowerExtension,
} from '@wildflowerhealthio/fhir-r4/data-types'
import { type Brand, type Either, Option, type ParseResult, pipe, Schema } from 'effect'

import { checkArrayHasOneMatchingElement } from '../internal/check-array-has-one-matching-element.ts'
import {
  type ArrayElementsCheck,
  filterArrayWithEveryCheck,
} from '../internal/filter-array-with-every-check.ts'
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

/** Checks a rule's sub-extensions hold exactly one at `part`, its value in range. */
const checkArrayHasOneProgressionRulePart = (part: PartName): ArrayElementsCheck<Extension.Type> =>
  checkArrayHasOneMatchingElement({
    matches: Extension.hasUrl(part),
    schema: PART_SCHEMAS[part],
    expected: `"${part}" part`,
  })

/**
 * How an exercise (definition)'s load moves between workouts, as FHIR
 * carries it on that exercise (definition)'s action: a
 * {@link WildflowerExtension.LiftingProgression} extension narrowed to exactly
 * one sub-extension per {@link Part}, each in range. Up by the increment after
 * a success; after enough consecutive failed workouts at one load, down by
 * the deload fraction, rounded down to a multiple of the load step and never
 * below the minimum load. Every amount is in the rule's unit, and only a load
 * in that unit progresses by this rule.
 */
interface TrainingPlanDefinitionProgressionRule
  extends Omit<Extension.Type, 'url'>, Brand.Brand<'TrainingPlanDefinitionProgressionRule'> {
  /** Always the `LiftingProgression` url. */
  readonly url: typeof WildflowerExtension.LiftingProgression
}

/**
 * Decodes an `Extension` into a
 * {@link TrainingPlanDefinitionProgressionRule} — fails, naming the part,
 * when it is not at the `LiftingProgression` url, or a part is missing,
 * repeated, or out of range.
 */
const TrainingPlanDefinitionProgressionRuleSchema: Schema.Schema<
  TrainingPlanDefinitionProgressionRule,
  Extension.Type
> = narrowedFrom<Extension.Type>()(
  narrowFields(Schema.typeSchema(Extension.Schema), {
    url: Schema.Literal(WildflowerExtension.LiftingProgression),
    extension: Schema.Array(Schema.typeSchema(Extension.Schema)).pipe(
      filterArrayWithEveryCheck([
        checkArrayHasOneProgressionRulePart(Part.Unit),
        checkArrayHasOneProgressionRulePart(Part.Increment),
        checkArrayHasOneProgressionRulePart(Part.FailuresBeforeDeload),
        checkArrayHasOneProgressionRulePart(Part.DeloadFraction),
        checkArrayHasOneProgressionRulePart(Part.MinimumLoad),
        checkArrayHasOneProgressionRulePart(Part.LoadStep),
      ])
    ),
  }).pipe(Schema.brand('TrainingPlanDefinitionProgressionRule'))
)

/**
 * A progression rule: every amount in `unit`.
 *
 * @returns The rule; or a `ParseError` naming each parameter out of range —
 *   `increment` and `loadStep` must be finite and positive,
 *   `failuresBeforeDeload` a positive integer, `deloadFraction` strictly
 *   between 0 and 1, `minimumLoad` finite and non-negative
 */
const make = (progressionRuleParameters: {
  readonly unit: Load.Unit
  readonly increment: number
  readonly failuresBeforeDeload: number
  readonly deloadFraction: number
  readonly minimumLoad: number
  readonly loadStep: number
}): Either.Either<TrainingPlanDefinitionProgressionRule, ParseResult.ParseError> =>
  Schema.decodeEither(TrainingPlanDefinitionProgressionRuleSchema, { errors: 'all' })({
    ...Extension.emptyAt(WildflowerExtension.LiftingProgression),
    extension: [
      { ...Extension.emptyAt(Part.Unit), valueString: progressionRuleParameters.unit },
      { ...Extension.emptyAt(Part.Increment), valueDecimal: progressionRuleParameters.increment },
      {
        ...Extension.emptyAt(Part.FailuresBeforeDeload),
        valueInteger: progressionRuleParameters.failuresBeforeDeload,
      },
      {
        ...Extension.emptyAt(Part.DeloadFraction),
        valueDecimal: progressionRuleParameters.deloadFraction,
      },
      {
        ...Extension.emptyAt(Part.MinimumLoad),
        valueDecimal: progressionRuleParameters.minimumLoad,
      },
      { ...Extension.emptyAt(Part.LoadStep), valueDecimal: progressionRuleParameters.loadStep },
    ],
  })

/** The one sub-extension at `part` of `progressionRule`, as `schema` reads it. */
const partOf = <A>(read: {
  readonly progressionRule: TrainingPlanDefinitionProgressionRule
  readonly part: PartName
  readonly schema: Schema.Schema<A>
}): A =>
  guaranteed(
    pipe(
      Extension.onlyAt(read.progressionRule.extension, read.part),
      Option.flatMap(Schema.validateOption(read.schema))
    )
  )

/** The unit the rule's amounts are in, and the only unit a load it moves may be in. */
const unitOf = (progressionRule: TrainingPlanDefinitionProgressionRule): Load.Unit =>
  partOf({ progressionRule, part: Part.Unit, schema: PART_SCHEMAS.unit }).valueString

/** Added to the load after a successful workout. */
const incrementOf = (progressionRule: TrainingPlanDefinitionProgressionRule): number =>
  partOf({ progressionRule, part: Part.Increment, schema: PART_SCHEMAS.increment }).valueDecimal

/** Consecutive failed workouts at one load that trigger a deload. */
const failuresBeforeDeloadOf = (progressionRule: TrainingPlanDefinitionProgressionRule): number =>
  partOf({
    progressionRule,
    part: Part.FailuresBeforeDeload,
    schema: PART_SCHEMAS.failuresBeforeDeload,
  }).valueInteger

/** The fraction of the load a deload takes off. */
const deloadFractionOf = (progressionRule: TrainingPlanDefinitionProgressionRule): number =>
  partOf({ progressionRule, part: Part.DeloadFraction, schema: PART_SCHEMAS.deloadFraction })
    .valueDecimal

/** The lightest load a deload may reach. */
const minimumLoadOf = (progressionRule: TrainingPlanDefinitionProgressionRule): number =>
  partOf({ progressionRule, part: Part.MinimumLoad, schema: PART_SCHEMAS.minimumLoad }).valueDecimal

/** The smallest change the equipment can make to the load. */
const loadStepOf = (progressionRule: TrainingPlanDefinitionProgressionRule): number =>
  partOf({ progressionRule, part: Part.LoadStep, schema: PART_SCHEMAS.loadStep }).valueDecimal

/**
 * The loads `progressionRule` moves: a {@link Load.Type} in the rule's unit — a rule
 * never converts between pounds and kilograms.
 */
const movableLoadSchema = (
  progressionRule: TrainingPlanDefinitionProgressionRule
): Schema.Schema<Load.Type> =>
  Schema.typeSchema(Load.Schema).pipe(
    Schema.filter((load) => Load.unitOf(load) === unitOf(progressionRule), {
      message: (issue) =>
        `expected a load in ${unitOf(progressionRule)}, the unit the rule moves, actual ${JSON.stringify(issue.actual)}`,
    })
  )

/**
 * The loads a lifter may start `progressionRule`'s exercise at: {@link movableLoadSchema},
 * and at or above the rule's minimum load.
 */
const startingLoadSchema = (
  progressionRule: TrainingPlanDefinitionProgressionRule
): Schema.Schema<Load.Type> =>
  movableLoadSchema(progressionRule).pipe(
    Schema.filter((load) => Load.valueOf(load) >= minimumLoadOf(progressionRule), {
      message: () =>
        `expected a load of at least ${minimumLoadOf(progressionRule)} ${unitOf(progressionRule)}`,
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
  TrainingPlanDefinitionProgressionRuleSchema as Schema,
  startingLoadSchema,
  unitOf,
}
export type { PartName, TrainingPlanDefinitionProgressionRule as Type }
