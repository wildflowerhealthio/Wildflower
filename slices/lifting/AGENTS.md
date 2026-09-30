# AGENTS.md — slices/lifting

**Strength-training plans**: a person's lifting program as a plan of exercises
and alternating workouts, the prescription they are working at for each
exercise, the sets they log against it, and the decision after each session
whether a lift's load goes up, holds, or deloads. FHIR's request pattern —
`PlanDefinition` → `ServiceRequest` → `Observation` — with StrongLifts 5×5 as
a template rather than a special case.

## Packages

- `lifting-core` — the pure lifting layer, and currently the whole slice. The
  root export is the domain:
  `Plan` (a branded, validated value — a title, one `PlannedExercise` per
  exercise in `exercisesById` (sets × reps and its `ProgressionRule`: `unit`,
  `increment`, failures before a deload, deload fraction, `minimumLoad` floor
  and `loadStep` rounding step, all in the rule's unit), and the `Workout`s in
  cycle order — built by `makePlan`, which returns `PlanInvalid` with every
  tagged `PlanProblem` it finds), `Prescription` (what the lifter is working
  at for one exercise: sets × reps at one `Load`, a `value` in `lb` or `kg`;
  made by `prescribe(plan, exerciseId, load)`, which refuses an unplanned
  exercise, a load in another unit than the rule's, or one under the floor),
  `SetResult` (one logged set: the exercise, its workout label, `start` /
  `end` and the `reps`), `sessionsOf` (the sets grouped into `Session`s by
  calendar date in the lifter's zone) and `sessionMet`,
  `progressPrescription(rule, prescription, sets, zone)` (the increment /
  hold / deload step, returning the `PrescriptionProgress` — the decision and
  the next prescription to issue, `None` on a hold — or `LoadUnitMismatch`)
  with `consecutiveFailures` for "failure 2 of 3", `nextWorkout` /
  `exercisesFor` (what the "today" screen shows), `exerciseIdFromName` (the
  one slug rule for exercise ids), and the `strongLifts5x5()` template with
  `STRONGLIFTS_STARTING_LOADS`. The `lifting-core/fhir` subpath is the FHIR
  R4 adapter pair per shape — `Prescription` ⇄ `ServiceRequest`, `SetResult`
  ⇄ `Observation` — over the decoded `fhir-r4` types; the `Plan` ⇄
  `PlanDefinition` adapter is the next PR in the stack. Each reader gives back
  a `Stored*` value with the ids an app rewrites the same resources with:
  `StoredPrescription` (the `ServiceRequest` id, the plan url it instantiates
  and its `status`), `StoredSetResult` (the request it is `basedOn`).
  `prescriptionProgressToFhir` turns a progression step into the requests to
  write — the current one closed, the next one issued in its place — and
  `revokedRequest` closes one on a change of program. The subpath also
  carries the lifting code literals (`LiftingMeasureCode`,
  `LiftingProgressionPart`), `planUrlOf` (the canonical url a request
  instantiates) and `LIFTING_FEATURE_TOKEN`. No DOM, no platform imports, no
  clock of its own.

The React layer and the app route are not built yet.

## Rules

- **The core owns every progression decision; React renders.** Whether a load
  goes up, holds or deloads, which workout is due, and how far a lift is from a
  deload are pure functions here, property-tested. A UI shows what this package
  returns; it does not re-derive any of it.
- **A plan is the program; a prescription is the lifter's state.** A `Plan`
  holds no load: it says how each exercise is run and how its load moves. The
  load lives on the `Prescription` — one per exercise the lifter is working
  at — and a prescription is one load: a met session closes it (`completed`)
  and issues the next one heavier, a deload closes it (`revoked`) and issues
  the next one lighter, a change of program revokes them all. Because the sets
  logged against a prescription are all at its load, `consecutiveFailures` is
  just the trailing failed sessions under it, and the next prescription
  starts with no sets.
- **A session is a calendar day in the lifter's zone.** `sessionsOf` groups a
  prescription's sets by the local date of each set's `start`; the zone is a
  parameter (`DateTime.TimeZone`), never a global. A lifter who quits after
  three sets and returns tomorrow has two sessions, each judged on its own by
  `sessionMet` (at least the prescribed sets, each reaching the prescribed
  reps; extra sets count neither way). Success is derived, never stored.
- **A `Plan` is validated by construction.** Any edit goes back through
  `makePlan`. The brand is type-level only — a spread like
  `{ ...plan, title: '' }` still type-checks as a `Plan`, so never build one
  that way. Because every `Plan` holds the invariants, `exercisesFor` is total
  — no workout exercise is ever skipped. An editor surfaces
  `PlanInvalid.problems` (tagged, with the offending label / exercise id /
  index) rather than keeping its own text checks; exercise ids must be slugs
  (`exerciseIdFromName(id) === id`).
- **Loads carry their unit, and a rule moves only its own unit.** A `Load` is
  a `value` in `lb` or `kg`, written as a UCUM `[lb_av]` or `kg`
  `Quantity`; any other UCUM code does not read. A `ProgressionRule`'s
  `increment`, `minimumLoad` and `loadStep` are in its `unit`;
  `prescribe` and `progressPrescription` refuse a load in the other unit
  (`LoadUnitMismatch`) rather than convert. A deload rounds down to a multiple
  of `loadStep` and never goes below `minimumLoad` (StrongLifts: 5 lb steps,
  the 45 lb bar); a deload that cannot lower the load holds instead. The
  StrongLifts template is pounds only.
- **Nothing disappears silently.** Every reader returns a tagged error listing
  every problem (`PrescriptionUnreadable`, `SetUnreadable`) and requires
  exactly one of each lifting-coded concept, extension and reference — a
  duplicate is unreadable, not "take the first". Each error's `message` names
  its problems. Problem variants that mean the same thing are shared across
  unions: `ExerciseUnreadable` (both readers), `PrescriptionOutOfRange`
  (`prescribe` and the request reader). The readers read a measure's raw
  value and leave the range to the domain's own check, so an out-of-range
  value is named by its field. `setResultFromFhir` returns `Right(None)` for
  a retracted observation (fhir-r4's `Observation.RETRACTED_STATUSES`), so
  the app counts skipped and unreadable sets separately, and reads `basedOn`
  so one search over a plan's sets can be grouped by request.
  `prescriptionFromFhir` reads `status` without checking it — the app
  searches `status=active`.
- **The wire shapes.** A `ServiceRequest` is `active`, intent `plan`,
  priority `routine`, the `strength-training` feature as `category`, the
  exercise as `code`, one `orderDetail` per measure (`load`, `sets`, `reps`),
  `instantiatesCanonical` the plan url (`planUrlOf(planDefinitionId)`),
  `replaces` the request it succeeds, `authoredOn` when issued. An
  `Observation` is `final`, in the `activity` category (HL7
  `observation-category`, as the Physical Activity IG does) with the exercise
  name as `code.text` so a generic viewer can label it, `basedOn` the
  request, `effectivePeriod` the set's span, `valueInteger` the reps, and the
  workout label in an extension. A lifting-measure concept carries its value
  in a `LiftingMeasureValue` extension — `valueQuantity` for a load,
  `valueInteger` for a count.
- **The FHIR adapters live behind the `lifting-core/fhir` subpath, never the
  root export**, so importing the domain does not pull in `fhir-r4`'s schemas.
  Its own `pack.entry` in `vite.config.ts` makes it a separate `vp pack`
  entry.
- **Wire urls live in `fhir-r4`, codes here.** The extension urls
  (`WildflowerExtension.LiftingProgression`, `.LiftingMeasureValue`,
  `.WorkoutLabel`), the code-system urls (`WildflowerCodeSystem.Exercise`,
  `.LiftingMeasure`, `.Feature`, under `WILDFLOWER_CODE_SYSTEM_BASE`) and the
  canonical base (`WILDFLOWER_CANONICAL_BASE`) are in `fhir-r4`'s
  `terminology.ts`; the `lifting-measure` codes (`LiftingMeasureCode`) and the
  progression sub-extension names (`LiftingProgressionPart`) are in
  `lifting-core/fhir`. All of them are persisted wire format — append, don't
  rename. The rule's `unit` part is a `valueString`, not a `valueCode`:
  fhir-r4 leaves the `code` datatype unregistered, so a `valueCode` fails to
  encode.
- **This package is a `fhir-r4` consumer**, so both
  [consumer gotchas](../emr/fhir-r4/docs/Consumer%20Gotchas%20Reference.md)
  apply. A decoded `Coding.system` is a `URL` (compare with
  `Coding.isInSystem`), and the `Quantity` and `Period` choice slots type as
  `any`, so they are re-decoded through `Schema.typeSchema(…)`. `vp pack`
  (not `vp check`) is the gate for the TS2883 dts trap: run
  `vp run -F lifting-core build` when an adapter's inferred types change.

## References

- [Architecture / slice layering](../AGENTS.md)
- [fhir-r4 Consumer Gotchas Reference](../emr/fhir-r4/docs/Consumer%20Gotchas%20Reference.md)
- [Property Testing Reference](../../docs/Testing/Property%20Testing%20Reference.md) — property tests are the default here
