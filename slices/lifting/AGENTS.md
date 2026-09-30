# AGENTS.md — slices/lifting

**Strength-training plans**: a person's lifting program as the FHIR R4
resources that store it — a `PlanDefinition` of workouts that cycle in order,
the `ServiceRequest` the lifter works at for each exercise, the `Observation`
of each set logged against it — and the decision after each session whether a
lift's load goes up, holds, or deloads. FHIR's workflow chain of
definition, order and event — `PlanDefinition` → `ServiceRequest` →
`Observation` — with StrongLifts 5×5 as a template rather than a special case.

## Packages

- `lifting-core` — the pure lifting layer, and currently the whole slice. Its
  root export is one namespace per concept, each mirroring a `fhir-r4`
  namespace: a `Schema` that decodes the decoded `fhir-r4` type into a `Type`
  narrowing it, a `make` that builds one from the domain inputs (returning the
  `Type` or a `ParseError`), and getters for the domain values it holds.
  - `Load` — a `Quantity` narrowed to a finite, non-negative `value` in UCUM
    `[lb_av]` or `kg` with no comparator (`valueOf`, `unitOf`, `withValue`).
  - `ExerciseConcept` — a `CodeableConcept` narrowed to exactly one coding in
    `WildflowerCodeSystem.Exercise`, its `code` a slug exercise id and its
    `display` the name (`idOf`, `nameOf`, and `idFromName`, the one slug rule).
  - `ProgressionRule` — a `LiftingProgression` extension narrowed to one
    sub-extension per `ProgressionRule.Part` (`unit`, `increment`,
    `failuresBeforeDeload`, `deloadFraction`, `minimumLoad`, `loadStep`), each
    in range, with a getter per part and `movableLoadSchema` /
    `startingLoadSchema`, the loads a rule moves and the loads a lifter may
    start at.
  - `PlannedExercise` — a `PlanDefinition.action` narrowed to one
    `ExerciseConcept`, one `sets` and one `reps` lifting-measure concept among
    its `code`s, and one `ProgressionRule` among its extensions.
  - `Workout` — a `PlanDefinition.action` narrowed to a non-blank `title` (the
    label) and a non-empty nested `action` of `PlannedExercise`s, in order.
  - `Plan` — a `PlanDefinition` narrowed to an `id`, a canonical `url`, a
    non-blank `title` and a non-empty `action` of `Workout`s in cycle order;
    `plannedExerciseOf`, `plannedExercisesOf`, `workoutsOf` and `nextWorkout`
    (what the "today" screen shows).
  - `ExerciseRequest` — a `ServiceRequest` whose service is an exercise,
    narrowed to an `id`, an `ExerciseConcept` `code`, exactly one
    `instantiatesCanonical` (the plan url) and exactly one `load`, `sets` and
    `reps` `orderDetail`: sets × reps at one `Load`. `make` refuses an
    exercise the plan does not run (`ExerciseUnplanned`), a load in another
    unit than the exercise's rule, or one under its floor. `progress` is the
    increment / hold / deload step: it returns the `Decision`, the current
    `ExerciseRequest` closed as it says, and the next one issued in its place
    (`None` on a hold). `close`, `forExercise`, `isMetBy` and
    `consecutiveFailures` ("failure 2 of 3") complete it.
  - `ExerciseSetObservation` — an `Observation` narrowed to an `id`, a status
    other than a retracted one, an `ExerciseConcept` `code`, an
    `effectivePeriod` with a start and an end at or after it, a non-negative
    `valueInteger` (the reps), exactly one `WorkoutLabel` extension and exactly
    one `basedOn` `ServiceRequest`. `make` takes the `ExerciseRequest` the set
    was performed against.
  - `Session` — the sets of one `ExerciseRequest` grouped by calendar date in
    the lifter's zone (`groupByDate`).
  - `StrongLifts5x5` — the template: `plan(planDefinitionId)`, `EXERCISES`
    and `STARTING_LOADS`.
  - `LiftingMeasureCode` and `LIFTING_FEATURE_TOKEN` — the lifting-measure
    codes and the search token that finds lifting resources.

  No DOM, no platform imports, no clock of its own.

The React layer and the app route are not built yet; the workout as a
`Procedure` is the next change to this package.

## Rules

- **Code passes the FHIR resource around.** A plan is a `Plan.Type`, a
  lifter's current load at an exercise an `ExerciseRequest.Type`, a set an
  `ExerciseSetObservation.Type`; each is still the `fhir-r4` type it narrows,
  so it encodes through the `fhir-r4` schema as it is. Nothing else carries
  the exercise, load, sets and reps: read them with the getters.
- **Validation is the schema.** Every range, slug, uniqueness and "exactly
  one" check is a field schema, a refinement or a brand on the concept's
  `Schema`, and every refusal is a `ParseError` whose issues name their path
  (`orderDetail.0.extension.0.valueQuantity.value`) — decode with
  `errors: 'all'` to have every problem at once. A refinement across fields
  runs only once the fields it reads decode, so a resource missing a narrowed
  field reports that before any "exactly one" problem. The one tagged error
  is `ExerciseRequest.ExerciseUnplanned`: the plan does not run the exercise,
  which no single value's schema can see.
- **Each `Schema` decodes the decoded `fhir-r4` type.** Its encoded side is
  `ServiceRequest.Type`, `Observation.Type`, `PlanDefinition.Type`,
  `PlanDefinitionAction.Type`, `Extension.Type`, `CodeableConcept.Type` or
  `Quantity.Type`, so a value from the `fhir-r4` client decodes directly and
  wire JSON decodes through `Schema.compose(<fhir-r4 Schema>, <lifting Schema>)`.
  The narrowing is built with `fhir-r4`'s `narrowFields` and `withMandatoryId`
  on `Schema.typeSchema` of the `fhir-r4` schema, which already checks every
  `fhir-r4` field, so the encoded side is declared rather than checked twice.
  A getter reads through what its schema guaranteed; on a value that never
  went through the schema it throws.
- **A plan is the program; an `ExerciseRequest` is the lifter's state.** A
  `Plan` holds no load: it says how each exercise is run and how its load
  moves. The load lives on the `ExerciseRequest` — one per exercise the
  lifter is working at — and an `ExerciseRequest` is one load: a met session
  closes it (`completed`) and issues the next one heavier, a deload closes it
  (`revoked`) and issues the next one lighter, a change of program revokes
  them all (`close`). Because the sets logged against one are all at its
  load, `consecutiveFailures` is just the trailing failed sessions under it,
  and the next one starts with no sets.
- **An exercise in several workouts is planned in each, identically.** A
  `Workout` carries its `PlannedExercise`s in full, so a workout never names
  an exercise the plan does not plan; `Plan.Schema` refuses one exercise
  planned two ways and two workouts with one label. Any edit goes back
  through the `make`s. `Plan.plannedExercisesOf` lists each exercise once.
- **A session is a calendar day in the lifter's zone.** `Session.groupByDate`
  groups an `ExerciseRequest`'s sets by the local date of each set's start;
  the zone is a parameter (`DateTime.TimeZone`), never a global. A lifter who
  quits after three sets and returns tomorrow has two sessions, each judged
  on its own by `ExerciseRequest.isMetBy` (at least the sets asked for, each
  reaching the reps asked for; extra sets count neither way). Success is
  derived, never stored.
- **Loads carry their unit, and a rule moves only its own unit.** A
  `ProgressionRule`'s `increment`, `minimumLoad` and `loadStep` are in its
  `unit`; `ExerciseRequest.make` and `progress` refuse a load in the other
  unit rather than convert. A deload rounds down to a multiple of `loadStep`
  and never goes below `minimumLoad` (StrongLifts: 5 lb steps, the 45 lb
  bar); a deload that cannot lower the load holds instead. The StrongLifts
  template is pounds only.
- **A retracted set does not decode.** An `ExerciseSetObservation` is a set
  that happened, so its schema refuses fhir-r4's
  `Observation.RETRACTED_STATUSES`; an app that counts skipped sets apart from
  unreadable ones checks the status before decoding. An `ExerciseRequest`'s
  status is not narrowed — the app searches `status=active`.
- **The wire shapes.** A `PlanDefinition` is `active`, its `url`
  `WILDFLOWER_CANONICAL_BASE/PlanDefinition/<id>`, the `strength-training`
  feature as `topic`, one `action` per workout (the label as its `title`),
  each with one nested `action` per exercise: the `ExerciseConcept`, `sets`
  and `reps` lifting-measure concepts as its `code`, and the rule as a
  `LiftingProgression` extension. An exercise `ServiceRequest` is `active`,
  intent `plan`, priority `routine`, the `strength-training` feature as
  `category`, the exercise as `code`, one `orderDetail` per measure (`load`,
  `sets`, `reps`), `instantiatesCanonical` the plan url, `replaces` the
  `ServiceRequest` it succeeds, `authoredOn` when issued. A set `Observation`
  is `final`, in the `activity` category (`Observation.ACTIVITY_CATEGORY`, as
  the Physical Activity IG files exercise) with the exercise name as
  `code.text` so a generic viewer can label it, `basedOn` its
  `ServiceRequest`, `effectivePeriod` the set's span, `valueInteger` the reps,
  and the workout label in a `WorkoutLabel` extension. A lifting-measure
  concept carries its value in a `LiftingMeasureValue` extension —
  `valueQuantity` for a load, `valueInteger` for a count.
- **Wire urls live in `fhir-r4`, codes here.** The extension urls
  (`WildflowerExtension.LiftingProgression`, `.LiftingMeasureValue`,
  `.WorkoutLabel`), the code-system urls (`WildflowerCodeSystem.Exercise`,
  `.LiftingMeasure`, `.Feature`) and `WILDFLOWER_CANONICAL_BASE` are in
  `fhir-r4`'s `terminology.ts`; the `lifting-measure` codes
  (`LiftingMeasureCode`) and the rule's sub-extension names
  (`ProgressionRule.Part`) are here. All of them are persisted wire format —
  append, don't rename. The rule's `unit` part is a `valueString`, not a
  `valueCode`: fhir-r4 leaves the `code` datatype unregistered, so a
  `valueCode` fails to encode.
- **Generic FHIR helpers belong to `fhir-r4`.** A one-coding concept
  (`CodeableConcept.make`), the single coding in a system
  (`CodeableConcept.onlyCodingIn`), the single extension at a url and an
  empty one to fill (`Extension.onlyAt`, `Extension.emptyAt`), a relative
  reference and the id it names (`IdentifierAndReference.referenceTo`,
  `referencedIdOf`), the `activity` category (`Observation.ACTIVITY_CATEGORY`)
  and field narrowing (`narrowFields`) are there; add the next one there too,
  with its test.
- **This package is a `fhir-r4` consumer**, so both
  [consumer gotchas](../emr/fhir-r4/docs/Consumer%20Gotchas%20Reference.md)
  apply. A decoded `Coding.system` is a `URL` (compare with
  `Coding.isInSystem`), and the `Quantity` and `Period` choice slots type as
  `any`, so they are decoded through `Schema.typeSchema(…)` of a narrowed
  schema (`Load.Schema`, the set's span). `vp pack` (not `vp check`) is the
  gate for the TS2883 dts trap: run `vp run -F lifting-core build` when a
  schema's types change. Every exported `Schema` is annotated with its `Type`
  for the same reason.
- **Property tests build through the `make`s.** A generated plan or
  `ExerciseRequest` is made from generated inputs, never by `Arbitrary.make`
  over a narrowed schema (whose refinements a random resource almost never
  meets). fhir-r4's `Extension` schema is costly to check, and decoding a
  plan checks every planned exercise's rule extension in every workout, so
  keep generated plans small and wire round trips few.

## References

- [Architecture / slice layering](../AGENTS.md)
- [fhir-r4 Consumer Gotchas Reference](../emr/fhir-r4/docs/Consumer%20Gotchas%20Reference.md)
- [Property Testing Reference](../../docs/Testing/Property%20Testing%20Reference.md) — property tests are the default here
