# AGENTS.md — apps/lifting-app

Lifting, a SMART-on-FHIR strength-training app published to
<https://wildflowerhealth.io/lifting-app/> (package `lifting-app`), launched
as `lifting-app-dev` under the vite dev server. See [README.md](./README.md)
for the boot structure, the reads, the tabs, the writes and the scopes.

`apps/health-viewer` is the template: the same two HTML entries, relative
`base`, build into the package's own `dist/`, `SmartAppRoot` shell with its own
Sentry DSN, and read-status lines.

## Rules

- **Compose; decide nothing.** The app wires `lifting-core` and
  `lifting-react` together and owns only the SMART shell, the reads, the ids,
  the clock and the writes. The day due, the progression, what a submission
  or a start writes, and every check on a training plan definition or a
  starting load are core's (`PlannedWorkout.make` / `submit`,
  `ExerciseRequest.changeTrainingPlanDefinition`); every value is read with
  core's getters.
- **Pass the narrowed FHIR resource.** Reads decode into
  `TrainingPlanDefinition.Type`, `ExerciseRequest.Type`,
  `WorkoutProcedure.Type` and `ExerciseSetObservation.Type`, and those are
  what the screens take and the writes send — never a copy of their fields.
- **Count what does not read.** A page entry that does not decode, and a
  resource core's `Schema` refuses, are counted per type
  (`UnreadableCounts`) and said in a banner. Retracted `Observation`s are
  filtered before decoding and not counted.
- **Every write is one batch, to minted ids, and refetches when it settles.**
  `useLiftingWrite` writes through `persistBatchBundleOrFail` and invalidates
  the lifter's queries on success and failure alike; `useLiftingWriting`
  disables every screen while any write is pending. A retry reuses what the
  first attempt fixed (`WorkoutAttempt`, `StartAttempt`), so its ids match.
- **Set ids sort in set order.** `exerciseSetObservationIdOf` zero-pads the
  set index and keeps the id within FHIR's grammar; change it only with its
  property tests.
- **Scopes match the clients.** `LIFTING_SCOPE` is the one string both
  launches request; the `lifting-app` and `lifting-app-dev` OAuth clients'
  `allowed_scopes` must equal it. Change both together.

## Testing

- `app.test.tsx` drives `App` and `LiftingApp` over an in-memory FHIR server:
  the real `fhir-r4-react/smart` readers over a stub client that answers
  searches from the store, and the real `buildSmartRouterContext` and
  `persistBatchBundleOrFail` over a stub transport that applies batches to it.
  Seeded records are built through `lifting-core`'s `make`s and
  `PlannedWorkout.submit`, and what lands is decoded back through core's
  schemas.
- `mint-ids.test.ts` — property tests: set ids are FHIR ids and sort in set
  order, long exercise ids stay apart, and a minter names one resource with
  one id on every call.
- `app-root.test.tsx` — that `AppRoot` mounts the shared shell as Lifting
  (the landing `h1` is `APP_DESCRIPTIONS.lifting.name`), reporting to its own
  Sentry project; the shell itself is tested in `smart-app-react`.
- `main.test.tsx` — the Pages 404 redirect is completed before anything reads
  the URL.

## References

- [slices/lifting/AGENTS.md](../../slices/lifting/AGENTS.md) — the slice this
  app composes.
- [apps/health-viewer/README.md](../health-viewer/README.md) — the template.
- [slices/emr/AGENTS.md](../../slices/emr/AGENTS.md) — `fhir-r4-react/smart`'s
  paged reads.
- [apps/AGENTS.md](../AGENTS.md) — the rules every app follows.
