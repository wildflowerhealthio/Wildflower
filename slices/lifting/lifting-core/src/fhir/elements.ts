import { Array as Arr, Data, Option, pipe, Schema } from 'effect'
import {
  Code,
  type CodeableConcept,
  Coding,
  Extension,
  IdentifierAndReference,
  Quantity,
  WildflowerCodeSystem,
  WildflowerExtension,
} from 'fhir-r4/data-types'

import type { Exercise } from '../plan.ts'

/**
 * The codes of {@link WildflowerCodeSystem.LiftingMeasure}: what a
 * strength-training `Goal.target.measure` or `Observation.component.code`
 * measures.
 *
 * @remarks
 * Persisted wire format, like the system url itself — a code written here is
 * only found again by the same code, so treat this as append-mostly.
 */
const LiftingMeasureCode = {
  /** A load in pounds, as a UCUM `[lb_av]` `Quantity`. */
  LoadLb: 'load-lb',
  /** A goal's sets per session, as an integer. */
  Sets: 'sets',
  /** A goal's reps per set, as an integer. */
  Reps: 'reps',
  /** The sets prescribed when an attempt was performed, as an integer. */
  PrescribedSets: 'prescribed-sets',
  /** The reps per set prescribed when an attempt was performed, as an integer. */
  PrescribedReps: 'prescribed-reps',
  /** The reps completed in one set of an attempt, as an integer; one component per set. */
  RepsCompleted: 'reps-completed',
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
  /** Pounds added after a success, as a `valueDecimal`. */
  IncrementLb: 'incrementLb',
  /** Consecutive failures at one load that trigger a deload, as a `valueInteger`. */
  FailuresBeforeDeload: 'failuresBeforeDeload',
  /** The fraction of the load a deload takes off, as a `valueDecimal`. */
  DeloadFraction: 'deloadFraction',
  /** The lightest load a deload may reach, in pounds, as a `valueDecimal`. */
  MinimumLoadLb: 'minimumLoadLb',
  /** The smallest change the equipment can make to the load, in pounds, as a `valueDecimal`. */
  LoadStepLb: 'loadStepLb',
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

/** UCUM's code for the avoirdupois pound — the only load unit this package writes or reads. */
const POUND_CODE = '[lb_av]'

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

/** A {@link LiftingMeasureCode} as a concept. */
const measureConcept = (measure: LiftingMeasure): Concept =>
  conceptOf(WildflowerCodeSystem.LiftingMeasure, measure, null, null)

/** The `CarePlanCategory` code a lifting plan's `CarePlan` is filed under. */
const LIFTING_PLAN_CATEGORY_CODE = 'strength-training'

/**
 * The `category` every lifting plan's `CarePlan` carries, so a search can ask
 * for lifting plans alone.
 */
const liftingPlanCategory: Concept = conceptOf(
  WildflowerCodeSystem.CarePlanCategory,
  LIFTING_PLAN_CATEGORY_CODE,
  'Strength training',
  'Strength training'
)

/**
 * The `CarePlan` `category` search token (`<system>|<code>`) that finds
 * lifting plans — pass it, unencoded, to a search that URL-encodes its
 * parameters.
 */
const LIFTING_PLAN_CATEGORY_TOKEN = `${WildflowerCodeSystem.CarePlanCategory}|${LIFTING_PLAN_CATEGORY_CODE}`

/** The `activity` observation category, as the Physical Activity IG files exercise observations. */
const activityCategory: Concept = conceptOf(
  OBSERVATION_CATEGORY_SYSTEM,
  'activity',
  'Activity',
  null
)

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

/** The exercise id a concept names: the code of its single exercise coding. */
const exerciseIdOf = (concept: Concept | null): Option.Option<string> =>
  onlyCodeIn(concept, WildflowerCodeSystem.Exercise)

/** Whether a concept is the given {@link LiftingMeasureCode}. */
const isMeasure =
  (measure: LiftingMeasure) =>
  (concept: Concept | null): boolean =>
    Option.contains(onlyCodeIn(concept, WildflowerCodeSystem.LiftingMeasure), measure)

/** A load in pounds as a UCUM `Quantity`. */
const poundsQuantity = (loadLb: number): Quantity.Type => ({
  id: null,
  extension: [],
  value: loadLb,
  unit: 'lb',
  system: UCUM_SYSTEM,
  code: Code.make(POUND_CODE),
  comparator: null,
})

/**
 * The pounds a decoded `value[x]` / `detail[x]` `Quantity` slot holds: a
 * finite, non-negative value in UCUM `[lb_av]`, with no comparator.
 *
 * @remarks
 * The slot types as `any` on a decoded resource, so it is re-decoded through
 * `Schema.typeSchema(Quantity.Schema)` — which expects exactly the decoded
 * shape — rather than read unchecked.
 */
const poundsOf = (slot: unknown): Option.Option<number> =>
  pipe(
    Schema.decodeUnknownOption(Schema.typeSchema(Quantity.Schema))(slot),
    Option.filter(
      (quantity) =>
        quantity.system === UCUM_SYSTEM &&
        quantity.code === POUND_CODE &&
        quantity.comparator === null
    ),
    Option.flatMap((quantity) => Option.fromNullable(quantity.value)),
    Option.filter((value) => value >= 0)
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

/** A non-negative integer — a count of reps completed. */
const isCount = (value: number): boolean => Number.isInteger(value) && value >= 0

export {
  activityCategory,
  exactlyOne,
  exerciseConcept,
  exerciseIdOf,
  exerciseOf,
  ExerciseUnreadable,
  extensionAt,
  isCount,
  isMeasure,
  LIFTING_PLAN_CATEGORY_TOKEN,
  LiftingMeasureCode,
  liftingPlanCategory,
  LiftingProgressionPart,
  measureConcept,
  onlyExtensionAt,
  poundsOf,
  poundsQuantity,
  referenceOf,
  referenceTo,
  workoutLabelExtension,
  workoutLabelOf,
}
export type { LiftingMeasure, LiftingProgressionPartName }
