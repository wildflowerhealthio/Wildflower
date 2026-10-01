# AGENTS.md — apps/lifting-app

Lifting, a SMART-on-FHIR strength-training app published to
<https://wildflowerhealth.io/lifting-app/> (package `lifting-app`), launched
as `lifting-app-dev` under the vite dev server. See [README.md](./README.md)
for the boot structure, the reads, the tabs, the writes and the scopes.

`apps/health-viewer` is the template: the same two HTML entries, relative
`base`, build into the package's own `dist/`, `SmartAppRoot` shell with its own
Sentry DSN, and read-status lines.

## Layout

`src/` keeps the entries and the root at its top: `main.tsx` and
`launch-main.tsx` (the `index.html` and `launch.html` entries), `config.ts`,
`app-root.tsx` (the package export), `app.tsx`, and the app-wide `clock.ts`
and `smart-client.ts`. Everything else is a folder per screen or concern:

- `lifting-app/` — `LiftingApp` (the header, with the patient chosen, and
  the **Today | Plan | History** toggle), `TrainingRecordTab` (one lifter's
  training record read, under Today and Plan) and `TabBody`, the tab shown
  over it.
- `today/`, `plan/`, `history/` — each tab, with the write it builds beside
  it (`today/submitted-workout-resources.ts`).
- `start-program/` — `StartProgram`, the start of a training plan definition
  the Today and Plan tabs share, with what it writes
  (`training-plan-definition-change-resources.ts`) and the current loads it
  suggests (`current-loads.ts`).
- `record/` — the lifter's record and its reads: `training-record.ts`
  (`readTrainingRecord`), `workout-history.ts` (`readWorkoutHistory`), the
  paging and decoding both share (`read-every-page.ts`), `UnreadableCounts`,
  and the notices that say what could not be read (`TrainingRecordNotices`,
  `UnreadableNotice`).
- `session/` — `LiftingSession` (one launch, for one lifter: what every
  write takes) and the write hooks every screen writes through
  (`use-lifting-write.ts`).
- `ids/` — the ids the app mints: `mintResourceId`,
  `exerciseSetObservationIdOf`, `workoutIdMinter` and
  `serviceRequestIdMinter`, one per file.

One component per file, named after it in kebab-case. A styled component has
its own CSS module beside it, BEM-named as `lifting-react`'s are: the block is
the file's name, read as `styles['block__element']`. Tests sit beside what
they cover.

## Rules

- **Compose; decide nothing.** The app wires `lifting-core` and
  `lifting-react` together and owns only the SMART shell, the reads, the ids,
  the clock and the writes; the patient is `smart-app-react`'s
  (`usePatientChoice`, `PatientPicker`, `PatientChoiceLine`). The day due, the
  progression, what a submission or a start writes, and every check on a
  training plan definition or a starting load are core's
  (`PlannedWorkout.make` / `submit`,
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
- **A write needs a lifter.** Only a chosen patient gets a
  `LiftingSession`, and every screen that writes takes one, so "All patients"
  cannot reach a write: it reads unscoped (History) and shows a "Choose a
  patient to train" card in place of Today and Plan. Queries sit under
  `liftingKeyOf` of the patient scope (`null` for All patients).
- **Every write is one batch, to minted ids, and refetches when it settles.**
  `useLiftingWrite` writes through `persistBatchBundleOrFail` and invalidates
  the lifter's queries on success and failure alike; `useLiftingWriting`
  disables every screen while any write is pending (`src/session/`). A retry
  reuses what the first attempt fixed (`WorkoutAttempt`, `StartAttempt`), so
  its ids match.
- **Set ids sort in set order.** `exerciseSetObservationIdOf` zero-pads the
  set index and keeps the id within FHIR's grammar; change it only with its
  property tests.
- **Scopes match the clients.** `LIFTING_SCOPE` is the one string both
  launches request — `system/` only, no `launch/patient`; the `lifting-app` and
  `lifting-app-dev` OAuth clients' `allowed_scopes` must equal it (gatekeeper
  migrations `0019_seed_lifting_app_client` and
  `0020_first_party_apps_pick_the_patient`, and `LIFTING_DEV_SCOPES` in
  `gatekeeper-rust/src/seeding.rs`, whose test reads `src/config.ts`). A
  change here is a new gatekeeper migration and a dev-scope edit too.

## Testing

- The screens are driven end to end through `LiftingApp` over an in-memory
  FHIR server: the real `fhir-r4-react/smart` readers over a stub client that
  answers searches from the store, and the real `buildSmartRouterContext` and
  `persistBatchBundleOrFail` over a stub transport that applies batches to it
  (`fake-fhir-server.test-helpers.ts`, which also answers reads of one
  resource, such as the lifter's `Patient`). Seeded records are built through
  `lifting-core`'s `make`s and `PlannedWorkout.submit`, and what lands is
  decoded back through core's schemas (`lifting-app.test-helpers.ts`). Each
  feature's test sits in its folder (`today/today-tab.test.tsx`,
  `record/training-record.test.tsx`, `session/use-lifting-write.test.tsx`,
  …); `lifting-app/lifting-app.test.tsx` drives every tab to check the scopes
  cover each read and write, and All patients' read-only tabs; `app.test.tsx`
  drives `App` over a stubbed handshake — the picker, a pick, the launch's
  patient and a change.
- `ids/*.test.ts` — property tests: set ids are FHIR ids and sort in set
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
