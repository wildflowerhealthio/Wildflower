import { Array as Arr, Data, Option, pipe, Schema } from 'effect'
import {
  Code,
  type CodeableConcept,
  Coding,
  Extension,
  IdentifierAndReference,
  Quantity,
  WILDFLOWER_CANONICAL_BASE,
  WildflowerCodeSystem,
  WildflowerExtension,
} from 'fhir-r4/data-types'

import type { Exercise, Load, LoadUnit } from '../plan.ts'

/**
 * The codes of {@link WildflowerCodeSystem.LiftingMeasure}: what a
 * strength-training `ServiceRequest.orderDetail` or
 * `PlanDefinition.action.code` concept measures. Each such concept carries its
 * value in a {@link WildflowerExtension.LiftingMeasureValue} extension.
 *
 * @remarks
 * Persisted wire format, like the system url itself — a code written here is
 * only found again by the same code, so treat this as append-mostly.
 */
const LiftingMeasureCode = {
  /** A load, as a UCUM `valueQuantity` (`[lb_av]` or `kg`). */
  Load: 'load',
  /** Sets per session, as a `valueInteger`. */
  Sets: 'sets',
  /** Reps per set, as a `valueInteger`. */
  Reps: 'reps',
} as const

/** One of the {@link LiftingMeasureCode} codes. */
type LiftingMeasure = (typeof LiftingMeasureCode)[keyof typeof LiftingMeasureCode]

/**
 * The sub-extension urls nested inside a
 * {@link WildflowerExtension.LiftingProgression} extension, one per
 * `ProgressionRule` field.
 *
 * @remarks
 * Relative names, not absolute urls: FHIR scopes a complex extension's
 * sub-extension `url` to its parent, so these mean something only inside a
 * `LiftingProgression` extension. Persisted wire format — append, don't rename.
 */
const LiftingProgressionPart = {
  /**
   * The unit the rule's amounts are in, as a `valueString` (`lb` or `kg`) —
   * a string, not a `valueCode`, which fhir-r4 leaves unregistered.
   */
  Unit: 'unit',
  /** Added after a success, as a `valueDecimal`. */
  Increment: 'increment',
  /** Consecutive failed sessions that trigger a deload, as a `valueInteger`. */
  FailuresBeforeDeload: 'failuresBeforeDeload',
  /** The fraction of the load a deload takes off, as a `valueDecimal`. */
  DeloadFraction: 'deloadFraction',
  /** The lightest load a deload may reach, as a `valueDecimal`. */
  MinimumLoad: 'minimumLoad',
  /** The smallest change the equipment can make to the load, as a `valueDecimal`. */
  LoadStep: 'loadStep',
} as const

/** One of the {@link LiftingProgressionPart} names. */
type LiftingProgressionPartName =
  (typeof LiftingProgressionPart)[keyof typeof LiftingProgressionPart]

/**
 * A reader problem shared by every resource that names an exercise: its
 * concept has no single exercise coding with a code and a display.
 */
interface ExerciseUnreadable {
  readonly _tag: 'ExerciseUnreadable'
}

/** Constructs an {@link ExerciseUnreadable} problem. */
const ExerciseUnreadable = Data.tagged<ExerciseUnreadable>('ExerciseUnreadable')

/** The UCUM system every load `Quantity` is coded in. */
const UCUM_SYSTEM = 'http://unitsofmeasure.org'

/** The UCUM code each load unit is written as: the avoirdupois pound, the kilogram. */
const UCUM_CODE_OF_UNIT: { readonly [Unit in LoadUnit]: string } = {
  lb: '[lb_av]',
  kg: 'kg',
}

/** {@link UCUM_CODE_OF_UNIT} the other way: the load unit each UCUM code names. */
const UNIT_OF_UCUM_CODE: ReadonlyMap<string, LoadUnit> = new Map(
  Object.entries(UCUM_CODE_OF_UNIT).map(([unit, code]): [string, LoadUnit] => [
    code,
    unit === 'kg' ? 'kg' : 'lb',
  ])
)

/** The load unit a UCUM code names, when it is one this package writes. */
const unitOfUcumCode = (code: string): Option.Option<LoadUnit> =>
  Option.fromNullable(UNIT_OF_UCUM_CODE.get(code))

/** HL7's `observation-category` code system, whose `activity` code the Physical Activity IG files exercise under. */
const OBSERVATION_CATEGORY_SYSTEM = 'http://terminology.hl7.org/CodeSystem/observation-category'

type Concept = typeof CodeableConcept.Schema.Type
type Reference = IdentifierAndReference.ReferenceType

/** The only element of a list, or `None` when it holds none or several. */
const exactlyOne = <A>(items: readonly A[]): Option.Option<A> =>
  items.length === 1 ? Arr.head(items) : Option.none()

/** A one-coding concept. */
const conceptOf = (
  system: string,
  code: string,
  display: string | null,
  text: string | null
): Concept => ({
  id: null,
  extension: [],
  coding: [
    {
      id: null,
      extension: [],
      system: new URL(system),
      code: Code.make(code),
      display,
      userSelected: null,
      version: null,
    },
  ],
  text,
})

/** The exercise as a concept: its id the code, its name the display and the text. */
const exerciseConcept = (exercise: Exercise): Concept =>
  conceptOf(WildflowerCodeSystem.Exercise, exercise.id, exercise.name, exercise.name)

/** The {@link WildflowerCodeSystem.Feature} code every lifting resource is filed under. */
const LIFTING_FEATURE_CODE = 'strength-training'

/**
 * The `strength-training` feature concept: a lifting `ServiceRequest`'s
 * `category` and a lifting `PlanDefinition`'s `topic`.
 */
const liftingFeatureConcept: Concept = conceptOf(
  WildflowerCodeSystem.Feature,
  LIFTING_FEATURE_CODE,
  'Strength training',
  'Strength training'
)

/**
 * The search token (`<system>|<code>`) that finds lifting resources: a
 * `ServiceRequest` search's `category`, a `PlanDefinition` search's `topic`
 * — pass it, unencoded, to a search that URL-encodes its parameters.
 */
const LIFTING_FEATURE_TOKEN = `${WildflowerCodeSystem.Feature}|${LIFTING_FEATURE_CODE}`

/** The `activity` observation category, as the Physical Activity IG files exercise observations. */
const activityCategory: Concept = conceptOf(
  OBSERVATION_CATEGORY_SYSTEM,
  'activity',
  'Activity',
  null
)

/** The canonical url of the lifting `PlanDefinition` stored under `planDefinitionId`. */
const planUrlOf = (planDefinitionId: string): string =>
  `${WILDFLOWER_CANONICAL_BASE}/PlanDefinition/${planDefinitionId}`

/** The single coding of `concept` under `system`; `None` when it has none or several. */
const onlyCodingIn = (concept: Concept | null, system: string): Option.Option<Coding.Type> =>
  pipe(
    Option.fromNullable(concept),
    Option.flatMap((present) => exactlyOne(present.coding.filter(Coding.isInSystem(system))))
  )

/** The code of the single coding under `system`. */
const onlyCodeIn = (concept: Concept | null, system: string): Option.Option<string> =>
  pipe(
    onlyCodingIn(concept, system),
    Option.flatMap((coding) => Option.fromNullable(coding.code))
  )

/** The exercise a concept names: id and name from its single exercise coding's code and display. */
const exerciseOf = (concept: Concept | null): Option.Option<Exercise> =>
  pipe(
    onlyCodingIn(concept, WildflowerCodeSystem.Exercise),
    Option.flatMap((coding) =>
      Option.all({
        id: Option.fromNullable(coding.code),
        name: Option.fromNullable(coding.display),
      })
    )
  )

/** Whether a concept carries any exercise coding. */
const namesExercise = (concept: Concept): boolean =>
  concept.coding.some(Coding.isInSystem(WildflowerCodeSystem.Exercise))

/**
 * The exercise the single exercise-coded concept in a list names; `None` when
 * no concept or several carry an exercise coding, or that one has no single
 * coding with a code and a display.
 */
const exerciseAmong = (concepts: readonly Concept[]): Option.Option<Exercise> =>
  pipe(exactlyOne(concepts.filter(namesExercise)), Option.flatMap(exerciseOf))

/** Whether a concept is the given {@link LiftingMeasureCode}. */
const isMeasure =
  (measure: LiftingMeasure) =>
  (concept: Concept): boolean =>
    Option.contains(onlyCodeIn(concept, WildflowerCodeSystem.LiftingMeasure), measure)

/** A load as a UCUM `Quantity`. */
const loadQuantity = (load: Load): Quantity.Type => ({
  id: null,
  extension: [],
  value: load.value,
  unit: load.unit,
  system: UCUM_SYSTEM,
  code: Code.make(UCUM_CODE_OF_UNIT[load.unit]),
  comparator: null,
})

/**
 * The load a decoded `value[x]` `Quantity` slot holds: a value in UCUM
 * `[lb_av]` or `kg`, with no comparator. Its range is not checked here: the
 * domain's own range check names the field.
 *
 * @remarks
 * The slot types as `any` on a decoded resource, so it is re-decoded through
 * `Schema.typeSchema(Quantity.Schema)` — which expects exactly the decoded
 * shape — rather than read unchecked.
 */
const loadOf = (slot: unknown): Option.Option<Load> =>
  pipe(
    Schema.decodeUnknownOption(Schema.typeSchema(Quantity.Schema))(slot),
    Option.filter((quantity) => quantity.system === UCUM_SYSTEM && quantity.comparator === null),
    Option.flatMap((quantity) =>
      Option.all({
        value: Option.fromNullable(quantity.value),
        unit: Option.flatMap(Option.fromNullable(quantity.code), unitOfUcumCode),
      })
    )
  )

/** A reference to `Type/id`. */
const referenceTo = (resourceType: string, id: string): Reference => ({
  ...IdentifierAndReference.emptyReference,
  reference: `${resourceType}/${id}`,
})

/** A literal reference, e.g. `Patient/p-1`. */
const referenceOf = (reference: string): Reference => ({
  ...IdentifierAndReference.emptyReference,
  reference,
})

/** The id a literal reference to `resourceType` names, e.g. `sr-1` from `ServiceRequest/sr-1`. */
const referencedIdOf = (reference: Reference, resourceType: string): Option.Option<string> =>
  pipe(
    Option.fromNullable(reference.reference),
    Option.filter((literal) => literal.startsWith(`${resourceType}/`)),
    Option.map((literal) => literal.slice(resourceType.length + 1)),
    Option.filter((id) => id.length > 0)
  )

/** An extension at `url` with no value, for a value slot or nested extensions to be spread onto. */
const extensionAt = (url: string): Extension.Type => ({
  ...Extension.emptyValueChoice,
  id: null,
  extension: [],
  url,
})

/** The single extension at `url` in a list; `None` when it holds none or several. */
const onlyExtensionAt = (
  extensions: readonly Extension.Type[],
  url: string
): Option.Option<Extension.Type> => exactlyOne(extensions.filter(Extension.hasUrl(url)))

/**
 * A {@link LiftingMeasureCode} concept carrying its value: the measure as the
 * coding, `value` spread onto a {@link WildflowerExtension.LiftingMeasureValue}
 * extension.
 */
const measureConcept = (measure: LiftingMeasure, value: Partial<Extension.Type>): Concept => ({
  ...conceptOf(WildflowerCodeSystem.LiftingMeasure, measure, null, null),
  extension: [{ ...extensionAt(WildflowerExtension.LiftingMeasureValue), ...value }],
})

/** A `sets` or `reps` concept carrying `count` as a `valueInteger`. */
const countConcept = (
  measure: typeof LiftingMeasureCode.Sets | typeof LiftingMeasureCode.Reps,
  count: number
): Concept => measureConcept(measure, { valueInteger: count })

/** A `load` concept carrying the load as a `valueQuantity`. */
const loadConcept = (load: Load): Concept =>
  measureConcept(LiftingMeasureCode.Load, { valueQuantity: loadQuantity(load) })

/**
 * The value extension of the single concept in a list measuring `measure`;
 * `None` when no concept or several measure it, or that one has no single
 * {@link WildflowerExtension.LiftingMeasureValue} extension.
 */
const measureValueAmong = (
  concepts: readonly Concept[],
  measure: LiftingMeasure
): Option.Option<Extension.Type> =>
  pipe(
    exactlyOne(concepts.filter(isMeasure(measure))),
    Option.flatMap((concept) =>
      onlyExtensionAt(concept.extension, WildflowerExtension.LiftingMeasureValue)
    )
  )

/**
 * The `valueInteger` of the single `measure` concept. Its range is not
 * checked here: the domain's own range check names the field.
 */
const countAmong = (
  concepts: readonly Concept[],
  measure: typeof LiftingMeasureCode.Sets | typeof LiftingMeasureCode.Reps
): Option.Option<number> =>
  pipe(
    measureValueAmong(concepts, measure),
    Option.flatMap((extension) => Option.fromNullable(extension.valueInteger))
  )

/** The load of the single `load` concept, when its `valueQuantity` is one {@link loadOf} reads. */
const loadAmong = (concepts: readonly Concept[]): Option.Option<Load> =>
  pipe(
    measureValueAmong(concepts, LiftingMeasureCode.Load),
    Option.flatMap((extension) => loadOf(extension.valueQuantity))
  )

/** The {@link WildflowerExtension.WorkoutLabel} extension carrying `label`. */
const workoutLabelExtension = (label: string): Extension.Type => ({
  ...extensionAt(WildflowerExtension.WorkoutLabel),
  valueString: label,
})

/** The `valueString` of the single {@link WildflowerExtension.WorkoutLabel} extension in a list. */
const workoutLabelOf = (extensions: readonly Extension.Type[]): Option.Option<string> =>
  pipe(
    onlyExtensionAt(extensions, WildflowerExtension.WorkoutLabel),
    Option.flatMap((extension) => Option.fromNullable(extension.valueString))
  )

export {
  activityCategory,
  countAmong,
  countConcept,
  exactlyOne,
  exerciseAmong,
  exerciseConcept,
  exerciseOf,
  ExerciseUnreadable,
  extensionAt,
  LIFTING_FEATURE_TOKEN,
  liftingFeatureConcept,
  LiftingMeasureCode,
  LiftingProgressionPart,
  loadAmong,
  loadConcept,
  loadQuantity,
  onlyExtensionAt,
  planUrlOf,
  referencedIdOf,
  referenceOf,
  referenceTo,
  unitOfUcumCode,
  workoutLabelExtension,
  workoutLabelOf,
}
export type { LiftingMeasure, LiftingProgressionPartName }
