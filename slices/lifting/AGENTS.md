# AGENTS.md — slices/lifting

**Strength-training plans**: a person's lifting program as a plan of exercise
goals and alternating workouts, the sessions they log against it, and the
decision after each session whether a lift's load goes up, holds, or deloads.
A lightweight take on HL7's Physical Activity IG — plan → goal → observation —
with StrongLifts 5×5 as a template rather than a special case.

## Packages

- `lifting-core` — the pure lifting layer. The root export is the domain:
  `Plan` (a branded, validated value — a title, one `ExerciseGoal` per
  exercise in `goalsByExerciseId`, and the `Workout`s in cycle order — built by
  `makePlan`, which returns `PlanInvalid` with every tagged `PlanProblem` it
  finds), `ExerciseGoal` (load, sets × reps, and its `ProgressionRule`:
  increment, failures before a deload, deload fraction, `minimumLoadLb` floor
  and `loadStepLb` rounding step), `ExerciseAttempt` (one logged performance:
  the exercise, prescribed sets × reps, and reps completed per set),
  `attemptSucceeded`, `progressGoal` / `progressPlan` (the increment / hold /
  deload step) with `consecutiveFailures` for "failure 2 of 3",
  `nextWorkout` / `goalsFor` (what the "today" screen shows),
  `exerciseIdFromName` (the one slug rule for exercise ids), and the
  `strongLifts5x5()` template. The `lifting-core/fhir` subpath is the FHIR R4
  adapter pair per shape — `Plan` ⇄ `CarePlan` + `Goal`s, `ExerciseGoal` ⇄
  `Goal`, `ExerciseAttempt` ⇄ `Observation` — over the decoded `fhir-r4` types.
  `planToFhir` takes the ids to write and a `created` instant (written as
  `CarePlan.created`) and files the `CarePlan` under the lifting `category`
  (`LIFTING_PLAN_CATEGORY_TOKEN`, the search token that finds lifting plans
  alone); `planFromFhir` reads them back as a `StoredPlan` — the plan, the
  `CarePlan` id, each exercise's `Goal` id, and `created` (`CarePlanIdMissing`
  and `CreatedUnreadable` — anything but a FHIR `dateTime` — are read
  problems) — so an app rewrites the same resources. Over stored plans,
  `currentPlanOf` picks the one to follow (latest `created`; none ranks last;
  ties keep input order) and `progressionGoalsToFhir` gives the `Goal`s a
  progression moved, under their stored ids (`StoredGoalMissing` when one has
  none). The subpath also carries the lifting code
  literals (`LiftingMeasureCode`, `LiftingProgressionPart`). No DOM, no platform imports.

- `lifting-react` — the browser screens an app's tabs switch between, over
  plain props and callbacks: `TodayView` (the due workout, a tap-to-decrement
  button per prescribed set, and "Log session" building one `ExerciseAttempt`
  per exercise), `ProgressionReview` (each goal's increment / hold / deload
  badge and "Apply progression", which hands back `progressPlan`'s result),
  `PlanEditor` (the form, seeded from a plan — or, for a new plan, from
  `strongLifts5x5` — and decoded through `makePlan`), and `HistoryView`
  (attempts by the viewer's local calendar day, newest first). It never
  fetches and never imports `lifting-core/fhir`. A new exercise's id
  comes from core's `exerciseIdFromName` (suffixed `-2`, `-3`, … past an id
  already taken); an existing one keeps its id when renamed. Every form
  problem is a `PlanProblem` from `makePlan`, shown under its field. Each
  screen's `error` is `unknown`, so a mutation's error passes straight to its
  `ErrorBanner`.

The app route is not built yet.

## Rules

- **The core owns every progression decision; React renders.** Whether a load
  goes up, holds or deloads, which workout is due, and how far a lift is from a
  deload are pure functions here, property-tested. A UI shows what this package
  returns; it does not re-derive any of it.
- **Success is derived, never stored.** `attemptSucceeded` reads the reps
  completed against the prescription. The `Observation.valueBoolean` the
  adapter writes is for FHIR readers that know nothing of lifting; the reader
  ignores it.
- **`progressGoal` is one idempotent step.** Only an attempt at the goal's
  current load moves it, and every move changes the load (`makePlan` requires
  `incrementLb > 0` and `0 < deloadFraction < 1`), so re-running the step on an
  already-progressed goal holds. The app persists the progressed goal once per
  session; the plan it stores is the state.
- **A `Plan` is validated by construction.** Any edit goes back through
  `makePlan`; `progressPlan` is the one internal step that preserves the
  invariants by construction (a property re-checks its output through
  `makePlan`). The brand is type-level only — a spread like
  `{ ...plan, title: '' }` still type-checks as a `Plan`, so never build one
  that way. Because every `Plan` holds the invariants, `goalsFor` and
  `planToFhir` are total — no workout exercise is ever skipped. An editor
  surfaces `PlanInvalid.problems` (tagged, with the offending label /
  exercise id / index) rather than keeping its own text checks; exercise ids
  must be slugs (`exerciseIdFromName(id) === id`).
- **Pounds only.** Every load is `…Lb`, written as a UCUM `[lb_av]` `Quantity`;
  a load in any other unit does not read. A deload rounds down to a multiple of
  the rule's `loadStepLb` and never goes below its `minimumLoadLb` (StrongLifts:
  5 lb steps, the 45 lb bar); a deload that cannot lower the load holds instead.
- **Nothing disappears silently.** Every reader returns a tagged error listing
  every problem (`PlanUnreadable`, `GoalUnreadable`, `AttemptUnreadable`) and
  requires exactly one of each lifting-coded target, component, extension and
  part, and exactly one given `Goal` per referenced id — a duplicate is
  unreadable (`GoalAmbiguous` for goals), not "take the first". Each error's
  `message` names its problems. Problem variants that mean the same thing
  are shared across unions: `ExerciseUnreadable` (goal and attempt readers)
  and `GoalOutOfRange` (`makePlan` and the goal reader). `attemptFromFhir`
  returns `Right(None)` for a retracted observation (fhir-r4's
  `Observation.RETRACTED_STATUSES`), so the app counts skipped and unreadable
  attempts separately. It does not read `focus` / `basedOn`: the app scopes its
  Observation search with `based-on=CarePlan/<id>`.
- **Attempts file under the `activity` category** (HL7 `observation-category`,
  as the Physical Activity IG does) with the exercise name as `code.text`, so a
  generic viewer like the health viewer can label them.
- **The FHIR adapters live behind the `lifting-core/fhir` subpath, never the
  root export**, so importing the domain does not pull in `fhir-r4`'s schemas.
  Its own `pack.entry` in `vite.config.ts` makes it a separate `vp pack`
  entry.
- **Wire urls live in `fhir-r4`, codes here.** The extension urls
  (`WildflowerExtension.LiftingProgression`, `.WorkoutLabel`) and code-system
  urls (`WildflowerCodeSystem.Exercise`, `.LiftingMeasure`, under
  `WILDFLOWER_CODE_SYSTEM_BASE`) are in `fhir-r4`'s `terminology.ts`; the
  `lifting-measure` codes (`LiftingMeasureCode`) and the progression
  sub-extension names (`LiftingProgressionPart`) are in `lifting-core/fhir`.
  All of them are persisted wire format — append, don't rename.
- **This package is a `fhir-r4` consumer**, so both
  [consumer gotchas](../emr/fhir-r4/docs/Consumer%20Gotchas%20Reference.md)
  apply. A decoded `Coding.system` is a `URL` (compare with
  `Coding.isInSystem`), and the `Quantity` choice slots type as `any`, so
  they are re-decoded through `Schema.typeSchema(Quantity.Schema)`. `vp pack`
  (not `vp check`) is the gate for the TS2883 dts trap: run
  `vp run -F lifting-core build` when an adapter's inferred types change.
- **No `Goal.startDate` or `Goal.target.dueDate`.** A lifting goal has no
  start or due date; the plan is open-ended and its state is the current load.

## References

- [Architecture / slice layering](../AGENTS.md)
- [fhir-r4 Consumer Gotchas Reference](../emr/fhir-r4/docs/Consumer%20Gotchas%20Reference.md)
- [Property Testing Reference](../../docs/Testing/Property%20Testing%20Reference.md) — property tests are the default here
