# AGENTS.md — slices/lifting

**Strength-training plans**: a person's lifting program as the FHIR R4
resources that store it — a `PlanDefinition` of days that cycle in order,
the `ServiceRequest` the lifter works at for each exercise, a `Procedure` for
each workout (one day of it) they perform and an `Observation` for each set
in it — and the
decision after each workout whether a lift's load goes up, holds, or deloads.
FHIR's workflow chain of definition, order and event — `PlanDefinition` →
`ServiceRequest` → `Procedure` and `Observation` — with StrongLifts 5×5 as a
template rather than a special case.

## Packages

- `lifting-core` — the pure lifting layer, and currently the whole slice. Its
  root export is one namespace per concept, each mirroring a `fhir-r4`
  namespace: a `Schema` that decodes the decoded `fhir-r4` type into a `Type`
  narrowing it, a `make` that builds one from the domain inputs (returning the
  `Type` or a `ParseError`), and getters for the domain values it holds.
  - `Load` — a `Quantity` narrowed to a finite, non-negative `value` in UCUM
    `[lb_av]` or `kg` with no comparator. Its unit is that UCUM code
    everywhere: `make({ value, unit })` takes it, `unitOf` reads it back, and
    `withValue` keeps it.
  - `ExerciseConcept` — a `CodeableConcept` narrowed to exactly one coding in
    `WildflowerCodeSystem.Exercise`, its `code` a slug exercise id and its
    `display` the name (`idOf`, `nameOf`, and `idFromName`, the one slug rule).
  - `TrainingPlanDefinition` — a `PlanDefinition` narrowed to an `id`, a
    canonical `url`, a non-empty, trimmed `title` and a non-empty `action` of
    days in cycle order; `exerciseOf`, `exercisesOf`, `daysOf` and `nextDay`
    (what the "today" screen shows, from the latest completed workout). Its
    parts are sub-namespaces, so a consumer writes
    `TrainingPlanDefinition.Day.Type`:
    - `TrainingPlanDefinition.Day` — a `PlanDefinition.action` narrowed to a
      non-empty, trimmed `title` (the label) and a non-empty nested `action`
      of exercises (definitions), in order (`labelOf`, `exercisesOf`).
    - `TrainingPlanDefinition.Exercise` — a nested `PlanDefinition.action`
      narrowed to one `ExerciseConcept`, one `sets` and one `reps` exercise
      parameter concept among its `code`s, and one progression rule among its
      extensions (`exerciseConceptOf`, `exerciseIdOf`, `setsOf`, `repsOf`,
      `progressionRuleOf`).
    - `TrainingPlanDefinition.ProgressionRule` — a `LiftingProgression`
      extension narrowed to one sub-extension per `Part` (`unit`,
      `increment`, `failuresBeforeDeload`, `deloadFraction`, `minimumLoad`,
      `loadStep`), each in range, with a getter per part and
      `movableLoadSchema` / `startingLoadSchema`, the loads a rule moves and
      the loads a lifter may start at.

    Inside these modules the types, schemas and variables carry their full
    names (`TrainingPlanDefinitionDaySchema`, `trainingPlanDefinitionDay`);
    the exports are short (`Schema`, `Type`, `make`, `labelOf`) because the
    namespace says the rest.

  - `ExerciseRequest` — a `ServiceRequest` whose service is an exercise,
    narrowed to an `id`, an `ExerciseConcept` `code`, exactly one
    `instantiatesCanonical` (the training plan definition url) and exactly
    one `load`, `sets` and `reps` `orderDetail`: sets × reps at one `Load`.
    `make` refuses an exercise the training plan definition does not run
    (`ExerciseNotInTrainingPlanDefinition`), a load in another
    unit than the exercise's rule, or one under its floor. `progress` is the
    increment / hold / deload step: it returns the `Decision`, the current
    `ExerciseRequest` closed as it says, and the next one issued in its place
    (`None` on a hold). `attemptsAt`, `isMetBy`, `consecutiveFailures`
    ("failure 2 of 3"), `close` and `forExercise` complete it.
  - `WorkoutProcedure` — a `Procedure` performing one day of a training plan
    definition, narrowed to an `id`, a status of `in-progress` or
    `completed`, the day's label as its `code` (in
    `WildflowerCodeSystem.Workout`), the training plan definition url as its
    one `instantiatesCanonical`, a `performedPeriod` with a start (and an end
    exactly once completed), and at least one `basedOn` `ServiceRequest` — the
    `ExerciseRequest`s it carries out. `make` starts one from
    `{ trainingPlanDefinition, trainingPlanDefinitionDay, … }`, refusing a day
    the training plan definition does not cycle through
    (`DayNotInTrainingPlanDefinition`) or `ExerciseRequest`s of another
    training plan definition, naming every one
    (`ExerciseRequestNotOfTrainingPlanDefinition`); `complete` ends it;
    `dayLabelOf` and `trainingPlanDefinitionUrlOf` read it; `latestCompleted`
    and `completedByStart` order them. A planned workout is derived (the
    `nextDay`), never stored.
  - `ExerciseSetObservation` — an `Observation` narrowed to an `id`, a status
    other than a retracted one, an `ExerciseConcept` `code`, an
    `effectivePeriod` with a start and an end at or after it, a non-negative
    `valueInteger` (the reps), exactly one `basedOn` `ServiceRequest` and
    exactly one `partOf` `Procedure`. `make` takes the `ExerciseRequest` the
    set was performed against and the `WorkoutProcedure` it was part of.
  - `StrongLifts5x5` — the template: `trainingPlanDefinition(planDefinitionId)`,
    `EXERCISES` and `STARTING_LOADS`.
  - `ExerciseParameter` (`Code`, the exercise parameter codes) and
    `LiftingFeature` (the `strength-training` feature `CODE`, its `concept`,
    and the `TOKEN` that searches for lifting resources).

  No DOM, no platform imports, no clock of its own.

The React layer and the app route are not built yet.

## Rules

- **Code passes the FHIR resource around.** A program is a
  `TrainingPlanDefinition.Type`, a lifter's current load at an exercise an
  `ExerciseRequest.Type`, a workout a `WorkoutProcedure.Type`, a set an
  `ExerciseSetObservation.Type`; each is still the `fhir-r4` type it narrows,
  so it encodes through the `fhir-r4` schema as it is. Nothing else carries the exercise, load, sets and reps:
  read them with the getters.
- **Validation is the schema.** Every range, slug, uniqueness and "exactly
  one" check is a field schema, a refinement or a brand on the concept's
  `Schema`, and every refusal is a `ParseError` whose issues name their path
  (`orderDetail.0.extension.0.valueQuantity.value`) — decode with
  `errors: 'all'` to have every problem at once. An "exactly one" check
  (`checkArrayHasOneMatchingElement`, and `checkArrayHasOneExerciseParameter`
  on it) filters the array field it constrains, so its issues sit under that
  field: one check as `Schema.filter(check)`, several on one array through
  `filterArrayWithEveryCheck([...])`, which runs them as one refinement so
  every check reports. A refinement
  across fields (two days with one label) runs only once the fields it reads
  decode. The tagged errors are the checks that relate two resources, which
  no single value's schema can see:
  `ExerciseRequest.ExerciseNotInTrainingPlanDefinition`, and
  `WorkoutProcedure.DayNotInTrainingPlanDefinition` and
  `WorkoutProcedure.ExerciseRequestNotOfTrainingPlanDefinition`.
- **Each `make` validates its own level.** A `TrainingPlanDefinition` is
  made from days already made, a day from exercises (definitions), an
  exercise (definition) from an `ExerciseConcept` and a progression rule, so
  an editor shows each row's problems where it makes the row, and the
  training plan definition's own (two days with one label, one exercise
  defined two ways) when it makes the training plan definition.
- **Each `Schema` decodes the decoded `fhir-r4` type.** Its encoded side is
  the `fhir-r4` type it narrows (`ServiceRequest.Type`, `Procedure.Type`,
  `Observation.Type`, `PlanDefinition.Type`, …), so a value from the
  `fhir-r4` client decodes directly and wire JSON decodes through
  `Schema.compose(<fhir-r4 Schema>, <lifting Schema>)`. The narrowing is
  built with `fhir-r4`'s `narrowFields` and `withMandatoryId` on
  `Schema.typeSchema` of the `fhir-r4` schema, which already checks every
  `fhir-r4` field, so the encoded side is declared rather than checked twice.
  A getter reads through what its schema guaranteed; on a value that never
  went through the schema it throws.
- **A training plan definition is the program; an `ExerciseRequest` is the
  lifter's state.** A `TrainingPlanDefinition` holds no load: it says how each exercise is run and how its load
  moves. The load lives on the `ExerciseRequest` — one per exercise the
  lifter is working at — and each is one load: a met attempt closes it
  (`completed`) and issues the next one heavier, a deload closes it
  (`revoked`) and issues the next one lighter, and a change of program
  revokes them all (`close`). Because every set logged against one is at its
  load, `consecutiveFailures` is just its trailing failed attempts, and the
  next one starts with none.
- **An exercise on several days is defined on each, identically.** A day
  carries its exercises (definitions) in full, so a day never names an
  exercise the training plan definition does not define;
  `TrainingPlanDefinition.Schema` refuses one exercise defined two ways and
  two days with one label. `TrainingPlanDefinition.exercisesOf` lists each
  exercise once.
- **Progression is judged per completed workout.** An attempt at an
  `ExerciseRequest` is a completed `WorkoutProcedure` that carried it out,
  with the sets logged against it (`basedOn`) in that workout (`partOf`);
  `attemptsAt` lists them in the order the workouts started. A workout still
  in progress is never judged, and a completed one with no set of the
  exercise is no attempt at it. An attempt is met when it has at least the
  sets asked for and each of the first that many reaches the reps asked for;
  extra sets count neither way. Success is derived, never stored.
  `TrainingPlanDefinition.nextDay` follows the latest completed workout's
  day (`WorkoutProcedure.latestCompleted`) around the cycle.
- **Loads carry their unit, and a rule moves only its own unit.** A
  progression rule's `increment`, `minimumLoad` and `loadStep` are in its
  `unit`, the same UCUM code a `Load` carries; `ExerciseRequest.make` and
  `progress` refuse a load in the other unit rather than convert. A deload rounds down to a multiple of `loadStep`
  and never goes below `minimumLoad` (StrongLifts: 5 lb steps, the 45 lb
  bar); a deload that cannot lower the load holds instead. The StrongLifts
  template is pounds only.
- **Only live resources decode.** A retracted `Observation` (fhir-r4's
  `Observation.RETRACTED_STATUSES`) fails to decode as an
  `ExerciseSetObservation`, so an app that counts skipped sets apart from
  unreadable ones filters those statuses out before decoding. A `Procedure`
  in any status but `in-progress` or `completed` fails to decode as a
  `WorkoutProcedure`, with a message that says so. An `ExerciseRequest`'s
  status is not narrowed — the app searches `status=active`. Each lifting
  resource is found by the search parameter its wire shape fills: a
  training plan definition by `topic` (`LiftingFeature.TOKEN`), an
  `ExerciseRequest` or a workout by `category` (the same token) and by
  `instantiates-canonical` (the training plan definition url), and a set by
  `based-on` (its `ServiceRequest`) or `part-of` (its workout's
  `Procedure`).
- **The wire shapes.** A `PlanDefinition` is `active`, its `url`
  `WILDFLOWER_CANONICAL_BASE/PlanDefinition/<id>`, the `strength-training`
  feature as `topic`, one `action` per day (the label as its `title`), each
  with one nested `action` per exercise (definition): the `ExerciseConcept`,
  `sets` and `reps` exercise parameter concepts as its `code`, and the rule as a
  `LiftingProgression` extension. An exercise `ServiceRequest` is `active`,
  intent `plan`, priority `routine`, the `strength-training` feature as
  `category`, the exercise as `code`, one `orderDetail` per exercise
  parameter (`load`, `sets`, `reps`), `instantiatesCanonical` the training
  plan definition url, `replaces` the `ServiceRequest` it succeeds,
  `authoredOn` when issued. A workout
  `Procedure` is `in-progress` until `completed`, the `strength-training`
  feature as `category`, its day's label as `code` in
  `WildflowerCodeSystem.Workout` (what a generic viewer labels it by; the
  training plan definition url beside it says which one the label belongs
  to), `instantiatesCanonical` the training plan definition url, `basedOn`
  the `ServiceRequest`s it carries out, and `performedPeriod` its span. A set
  `Observation` is `final`, in the `activity` category
  (`Observation.ACTIVITY_CATEGORY`, as the Physical Activity IG files
  exercise) with the exercise name as `code.text` so a generic viewer can
  label it, `basedOn` its `ServiceRequest`, `partOf` its workout's
  `Procedure`, `effectivePeriod` the set's span and `valueInteger` the reps.
  An exercise parameter concept carries its value in an
  `ExerciseParameterValue` extension — `valueQuantity` for a load, `valueInteger` for a count.
- **Instants are UTC.** Every `performedPeriod` and `effectivePeriod` bound
  decodes to a `DateTime.Utc` and re-encodes as a UTC instant (see the
  consumer gotcha below), and nothing here reads a local time of day: which
  sets belong together is the workout they are `partOf`, not a calendar date.
- **Wire urls live in `fhir-r4`, codes here.** The extension urls
  (`WildflowerExtension.LiftingProgression`, `.ExerciseParameterValue`), the
  code-system urls (`WildflowerCodeSystem.Exercise`, `.ExerciseParameter`,
  `.Feature`, `.Workout`) and `WILDFLOWER_CANONICAL_BASE` are in `fhir-r4`'s
  `terminology.ts`; the exercise parameter codes (`ExerciseParameter.Code`),
  the feature code (`LiftingFeature.CODE`) and the rule's sub-extension names
  (`TrainingPlanDefinition.ProgressionRule.Part`) are here. All of them are persisted wire format —
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
- **This package is a `fhir-r4` consumer**, so every
  [consumer gotcha](../emr/fhir-r4/docs/Consumer%20Gotchas%20Reference.md)
  applies. A decoded `Coding.system` is a `URL` (compare with
  `Coding.isInSystem`); the `Quantity` and `Period` choice slots
  (`valueQuantity`, `effectivePeriod`, `performedPeriod`) type as `any`, so
  they are decoded through `Schema.typeSchema(…)` of a narrowed schema
  (`Load.Schema`, a set's or a workout's span); and a `dateTime` re-encodes as
  a UTC instant. `vp pack` (not `vp check`) is the gate for the TS2883 dts
  trap: run `vp run -F lifting-core build` when a schema's types change.
  Every exported `Schema` is annotated with its `Type` for the same reason.
- **Property tests build through the `make`s.** A generated training plan
  definition, `ExerciseRequest`, workout or set is made from generated
  inputs, never by `Arbitrary.make` over a narrowed schema (whose refinements
  a random resource almost never meets). fhir-r4's `Extension` schema is
  costly to check, and decoding a training plan definition checks every
  exercise (definition)'s rule extension on every day, so keep generated
  ones small and wire round trips few.

## References

- [Architecture / slice layering](../AGENTS.md)
- [fhir-r4 Consumer Gotchas Reference](../emr/fhir-r4/docs/Consumer%20Gotchas%20Reference.md)
- [Property Testing Reference](../../docs/Testing/Property%20Testing%20Reference.md) — property tests are the default here
