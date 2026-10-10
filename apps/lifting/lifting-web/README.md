# lifting-web

The first-party Lifting SMART-on-FHIR app: a lifter's strength-training program,
the workout due today, and every set they lift, kept on their own FHIR record.
One HTML entry, `index.html`: the app root, which starts a SMART launch its URL
carries (an EHR's `iss` and `launch`, or a lone `iss`), completes the handshake
and renders the app when a callback is in the URL, and shows the standalone
connect menu, where the user picks a FHIR server, on a bare visit.

The screens are [`lifting-react`](../AGENTS.md)'s; every
lifting decision — the day due, whether an attempt met its request, where a
load goes next, what a submitted workout and a program start write — is
[`lifting-core-js`](../AGENTS.md)'s. This package is the SMART
shell around them: it reads the record, mints the ids, reads the clock and
writes what core returns.

## Boot structure

The entry runs on `smart-app-react`, the chrome every first-party SMART app
boots through (see [slices/smart-app-react/AGENTS.md](../../../slices/smart-app-react/AGENTS.md)),
exactly as `apps/health-viewer/health-viewer-web` does.

`src/main.tsx` is the `index.html` entry: it imports the design-system
stylesheet module (`react-tundraish/styles`), completes a GitHub Pages 404
redirect, wires the OS colour-scheme listener, and renders `<AppRoot />` inside
`<StrictMode>`.

`src/app-root.tsx` exports `AppRoot`: `<SmartAppRoot app="lifting"
registration={smartRegistration} telemetry={smartAppTelemetry}>` around
`<App />`. `SmartAppRoot` shows the telemetry consent dialog first, then
starts a launch the URL carries under a loading line or renders one of the
other two branches (`smartAppTelemetry` in `src/config.ts` names the app's Sentry project
through the `VITE_SENTRY_DSN_LIFTING_WEB` build variable; see `.env.example`),
owns the single `QueryClientProvider`, and branches, latched on mount, on
whether a SMART callback is in the URL — the slim `BrandBar` above `<App />`
when launched, the full Wildflower chrome with `APP_DESCRIPTIONS.lifting`'s
`AppLanding` beside `ConnectMenu` on a bare visit.

## The page

`src/app.tsx`'s `App` completes the handshake and builds the write runner
(`buildSmartRouterContext` over `FetchHttpClient.layer`). The patient is
`smart-app-react`'s `usePatientChoice`: the URL's `?patient=`, else the
launch's `client.patient.id`, else its `PatientPicker` ("All patients" first,
then every patient by name and birth date), whose choice is written to the URL
as `?patient=<id>` or `?patient=*`. Then
`src/lifting-app/lifting-app.tsx`'s `LiftingApp`, remounted per choice, shows
the record under a **Today | Plan | History** toggle, with the choice named
under the title by `PatientChoiceLine` and a "Change patient" link back to the
picker.

- **A lifter** (one patient): their training record, read and written as
  below.
- **All patients**: read-only. The page opens on History, every patient's
  completed workouts read unscoped. Today and Plan write, and a write names
  one lifter, so each shows a "Choose a patient to train" card whose action
  goes back to the picker; no write control mounts. Only a chosen lifter has a
  `LiftingSession` (`src/session/`), the one thing the writes take.

### Reads (`src/record/`)

Every search is read to its last page (`fetchAllResourcePages`) and every
resource decoded through `lifting-core-js`'s `Schema`; what does not decode is
counted and said in a banner, never dropped in silence. Retracted
`Observation`s (`Observation.RETRACTED_STATUSES`) are left out before decoding:
withdrawn, not unreadable.

- **The training record** (`readTrainingRecord`, `training-record.ts`), what the app opens on:
  1. The patient's active lifting `ServiceRequest`s
     (`fetchActiveServiceRequestPage`, `category` = `LiftingFeature.TOKEN`, any
     definition), decoded as `ExerciseRequest`s. None → no current program.
  2. The training plan definition they follow is the url the latest-authored
     one instantiates. Then, at once: the lifting `PlanDefinition`s
     (`fetchPlanDefinitionPage`, `topic` = the same token), the one with that
     url picked; the workouts under it (`fetchProcedurePage` with the url); and
     the sets `based-on` each active request
     (`fetchObservationBasedOnOrPartOfPage`).

  Sets are searched per active request, not `part-of` per workout: the
  attempts at the active requests are all `PlannedWorkout.make` judges, and it
  is one search per exercise of the program however long the history, where
  per workout it would grow a search with every workout performed.

- **The history** (`readWorkoutHistory`, `workout-history.ts`), read only when the History tab
  opens: every lifting `ServiceRequest` in any status (`fetchServiceRequestPage`
  — closed requests too, since each workout was judged against the one it
  carried out) and every lifting workout, then the sets `part-of` each
  completed workout — one search per workout the history shows.

### The tabs

- **Today** (`src/today/today-tab.tsx`). With a current program,
  `PlannedWorkout.make` over it, shown by `PlannedWorkoutView`. "Submit workout" runs
  `PlannedWorkout.submit` with the launch patient as `subject` and a `mintId`
  from `workoutIdMinter`, and writes the completed `Procedure`, every set's
  `Observation`, and each moved request's closed `current` and its `next` (a
  hold writes nothing) in one batch; `SubmittedWorkoutView` shows the outcome
  until "Next workout". With no program, `StartProgram`
  (`src/start-program/start-program.tsx`) offers StrongLifts 5×5 at
  `StrongLifts5x5.STARTING_LOADS`, and writes the template's
  `PlanDefinition` with its requests in one batch. When the day due has an
  exercise with no active request or several, the refusal is shown above a
  restart of the program at the current loads.
- **Plan** (`src/plan/plan-tab.tsx`). `TrainingPlanDefinitionEditor` over the
  current program (or an empty form, which offers StrongLifts 5×5). "Save"
  writes the made training plan definition as a new `PlanDefinition` — under an
  id minted when the tab opens, so workouts and closed requests of the old one
  keep reading against its url — then `StartProgram` starts it at the current
  loads: `ExerciseRequest.changeTrainingPlanDefinition`'s revoked and started
  requests in one batch.
- **History** (`src/history/history-tab.tsx`). `WorkoutHistoryView` over the
  history read: the lifter's, or every patient's for All patients.

### Writes

Every write is one batch `Bundle` through `persistBatchBundleOrFail`, each
resource `PUT` to an id the app minted (`src/ids/`); it fails unless
every entry was accepted. Once it settles, failed or not, the record is read
again, and every screen's controls stay disabled until that lands
(`src/session/use-lifting-write.ts`).

A batch's entries land independently, so a failed write may have partly
landed. Its first attempt fixes what it writes from — the planned workout and
its `mintId`, or the requests a start revokes, its `mintServiceRequestId` and
its `authoredOn` — and a retry writes from the same, overwriting what landed
under the same ids rather than writing beside it.

Ids are random UUIDs, except each set's `Observation`:
`<procedureId>-<exerciseId>-<setIndex>`, the set index zero-padded to two
digits (more when an exercise asks for 100 sets or more) and the exercise id
cut to keep the id within FHIR's 64 characters (its head and an FNV-1a hash
when it is too long). A workout's sets tie on start, so
`ExerciseSetObservation.sortByStart` orders them by id: these sort in set
order.

## Scopes

One scope string for the EHR launch and the standalone connect
(`smartRegistration`, in `src/config.ts`):

```text
launch openid fhirUser system/Patient.rs system/PlanDefinition.crus system/ServiceRequest.crus system/Procedure.crus system/Observation.crus
```

`system/` scopes only, with no `launch/patient`: the lifter is picked in the
app, so the authorization server binds no patient to the token, and each
search is scoped with `patient=` (or unscoped for All patients).
`system/Patient.rs` reads the patients the picker lists and the one named
under the title. `crus` is create + read + update + search: every write is an
update to a client-minted id that creates the resource the first time, and the
app never deletes. That one string is what the `lifting` tile's OAuth client
(gatekeeper migrations `0019_seed_lifting_app_client`,
`0020_first_party_apps_pick_the_patient` and `0025_rekey_lifting_app_clients`)
and the debug-only `lifting-dev` tile's client (`seed_dev_app_clients` in
`gatekeeper-rust/src/seeding.rs`) allow, exactly; a test there reads
`src/config.ts` and pins both clients to it.

## Where the bundle is served

`vp build` writes this package's default `dist/`, and that build is served in
one place: **the published site**, at
[`/lifting`](https://wildflowerhealth.io/lifting/). `wildflower-site-web`
copies `dist/` into the Pages artifact
([../../wildflower-site/wildflower-site-web/README.md](../../wildflower-site/wildflower-site-web/README.md)), and each pull
request's `pr-preview.yml` build publishes the same tree under
`https://wildflowerhealthio.github.io/staging/pr-<n>/lifting/`. The
published page launches standalone against any SMART server that lets it write
these four resource types. Nothing ships on device.

## Registration

`src/config.ts`'s `clientId` is `bdf9fc5cb5a28c6683b49896b0ef8a75` in a
production build and `8467e680a05f1e92e22864e923144e5a` under the vite dev
server — random ids (`openssl rand -hex 16`), not the tile ids — and must equal
the `client_id` of the app row it is launched through — a launch checks the
caller's grant against that client's scopes, and `/authorize` matches the
redirect against that client's registered URIs — and its scope string must
equal the client's allowed scopes.

- **`lifting`** is a row (apps migration `0010_seed_lifting_app`, its URL as
  `0016_launch_first_party_apps_at_root` left it, re-keyed by
  `0017_rekey_lifting_app`) launching
  `https://wildflowerhealth.io/lifting/?launch={launch}&iss={origin}/fhir-r4`
  with `requires_tunnel` set, as every first-party row has. Its public
  OAuth client (gatekeeper migration `0019_seed_lifting_app_client`, its
  scopes as `0020_first_party_apps_pick_the_patient` left them, re-keyed by
  `0025_rekey_lifting_app_clients`) redirects to
  `https://wildflowerhealth.io/lifting/`.
- **`lifting-dev`** is seeded in debug builds only, at runtime rather than
  by a migration: a row on the dev server's port
  (`apps-rust/src/dev_seed.rs`) and its client, redirecting to
  `http://localhost:<port>/` (`gatekeeper-rust/src/seeding.rs`).

## Running locally

```bash
vp run -F @wildflowerhealthio/lifting-web dev     # strictPort, from dev-app-ports.json
```

Open the printed `http://localhost:<port>/`, pick a server on the connect menu,
sign in, and choose a patient (or All patients) in the app. The port has a single source,
`dev-app-ports.json` (`lifting-dev`): `vite.config.ts` reads it
through the shared `devAppServer` helper in the root `vite.config.base.ts`.
