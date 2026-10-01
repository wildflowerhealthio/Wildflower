import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, within } from '@testing-library/react'
import type userEvent from '@testing-library/user-event'
import { DateTime, Option, Schema } from 'effect'
import { buildSmartRouterContext } from 'fhir-r4-react/smart'
import { IdentifierAndReference } from 'fhir-r4/data-types'
import { Observation, PlanDefinition, Procedure, ServiceRequest } from 'fhir-r4/resources'
import {
  ExerciseConcept,
  ExerciseRequest,
  ExerciseSetObservation,
  LiftingFeature,
  Load,
  PlannedWorkout,
  StrongLifts5x5,
  TrainingPlanDefinition,
  WorkoutProcedure,
} from 'lifting-core'
import { made } from 'lifting-core/test-helpers'
import { createElement, type ReactNode, StrictMode } from 'react'
import type { PatientChoice } from 'smart-app-react'
import { vi } from 'vite-plus/test'

import {
  ACCESS_TOKEN,
  type FakeFhirServer,
  fakeFhirServer,
  resourceTypeOfWire,
  SERVER_URL,
} from './fake-fhir-server.test-helpers.ts'
import { LiftingApp } from './lifting-app/lifting-app.tsx'

/**
 * The app's own wiring, end to end, over an in-memory FHIR server
 * (`fake-fhir-server.test-helpers.ts`): reads go through the real
 * `fhir-r4-react/smart` page readers, writes through the real
 * `buildSmartRouterContext` and `persistBatchBundleOrFail`, and every decision
 * through the real `lifting-core`. Only the SMART handshake (which needs a
 * browser redirect) and `useLaunchFailureRedirect` (which would navigate away)
 * are stubbed, in `app.test.tsx`.
 *
 * What only this layer can show: that what the screens hand back is what
 * lands on the server, and reads back as the record the next screen shows;
 * that a retry rewrites the same ids; that every write is addressed to the
 * FHIR base with the granted token; and that what the server holds but the
 * app cannot read is said, not dropped.
 */

const PATIENT_ID = 'pat-1'
const SUBJECT = { reference: `Patient/${PATIENT_ID}` }
/** The lifter's own `Patient`, which the app names under its title. */
const PATIENT_WIRE = {
  resourceType: 'Patient',
  id: PATIENT_ID,
  name: [{ given: ['Ada'], family: 'Lovelace' }],
  birthDate: '1990-01-01',
}
/** The lifter's choice, as `usePatientChoice` hands it over. */
const LIFTER_CHOICE: PatientChoice = { kind: 'patient', patientId: PATIENT_ID }
/** When every workout in these tests is submitted. */
const SUBMITTED_AT = '2026-09-28T18:30:00.000Z'

/** The StrongLifts 5×5 program a seeded lifter follows. */
const SEEDED_PLAN_DEFINITION_ID = 'pd-strong-lifts'
const seededTrainingPlanDefinition =
  StrongLifts5x5.trainingPlanDefinition(SEEDED_PLAN_DEFINITION_ID)

/**
 * How long one end-to-end test may take: generous, since a file's first test
 * also pays for loading and first rendering every screen, and the files run
 * side by side.
 */
const END_TO_END_TIMEOUT_MILLIS = 20_000

/**
 * Start a test: a server holding only the lifter's `Patient`, and the clock
 * stopped at {@link SUBMITTED_AT}.
 */
const startLiftingTest = (): FakeFhirServer => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(SUBMITTED_AT))
  const server = fakeFhirServer()
  server.seedWire(PATIENT_WIRE)
  return server
}

/** End a test: unmount what it rendered and restart the clock. */
const endLiftingTest = (): void => {
  cleanup()
  vi.useRealTimers()
}

// ---------------------------------------------------------------------------
// The lifter's record, built through lifting-core
// ---------------------------------------------------------------------------

/** The `strength-training` category as hand-written wire carries it. */
const [liftingCategorySystem = '', liftingCategoryCode = ''] = LiftingFeature.TOKEN.split('|')
const liftingCategoryWire = {
  coding: [{ system: liftingCategorySystem, code: liftingCategoryCode }],
}

/** The seeded lifter's first `ExerciseRequest`s: StrongLifts at its starting loads, as `sr-<exercise id>`. */
const seededExerciseRequests = (): readonly ExerciseRequest.Type[] =>
  made(
    ExerciseRequest.makeForEachExercise({
      subject: SUBJECT_REFERENCE,
      trainingPlanDefinition: seededTrainingPlanDefinition,
      startingLoads: StrongLifts5x5.STARTING_LOADS,
      mintServiceRequestId: (exerciseId) => `sr-${exerciseId}`,
      authoredOn: DateTime.unsafeMake('2026-09-01T09:00:00Z'),
    })
  )

/** The seeded lifter's `subject`, as the app writes it. */
const SUBJECT_REFERENCE = IdentifierAndReference.referenceTo({
  resourceType: 'Patient',
  id: PATIENT_ID,
})

/** Seed a lifter who has just started StrongLifts 5×5: the program and its requests. */
const seedStartedLifter = (server: FakeFhirServer): void => {
  server.seedResource(seededTrainingPlanDefinition)
  for (const exerciseRequest of seededExerciseRequests()) server.seedResource(exerciseRequest)
}

/**
 * Seed the workout due next as `PlannedWorkout.submit` writes it, with
 * `setRepsByExerciseId`, from what the server holds, a day after the last
 * workout it holds.
 */
const seedWorkout = (
  server: FakeFhirServer,
  setRepsByExerciseId: PlannedWorkout.SetRepsByExerciseId
): void => {
  const index = server.storedIds('Procedure').length
  const start = DateTime.unsafeMake(Date.UTC(2026, 8, 2 + index, 17, 30))
  const submitted = made(
    PlannedWorkout.submit({
      plannedWorkout: made(
        PlannedWorkout.make({
          trainingPlanDefinition: seededTrainingPlanDefinition,
          exerciseRequests: server.stored('ServiceRequest', exerciseRequestWireSchema),
          workoutProcedures: server.stored('Procedure', workoutProcedureWireSchema),
          exerciseSetObservations: server.stored('Observation', exerciseSetObservationWireSchema),
        })
      ),
      subject: SUBJECT_REFERENCE,
      start,
      end: DateTime.addDuration(start, '1 hour'),
      setRepsByExerciseId,
      mintId: (idToMint) => {
        if (idToMint.resourceType === 'Procedure') return `workout-${index}`
        if (idToMint.resourceType === 'Observation')
          return `set-${index}-${idToMint.exerciseId}-${String(idToMint.setIndex).padStart(2, '0')}`
        return `sr-${index}-${idToMint.exerciseId}`
      },
    })
  )
  server.seedResource(submitted.workoutProcedure)
  for (const set of submitted.exerciseSetObservations) server.seedResource(set)
  for (const { decision, current, next } of submitted.exerciseRequestProgresses) {
    if (decision === 'hold') continue
    server.seedResource(current)
    for (const nextExerciseRequest of Option.toArray(next)) server.seedResource(nextExerciseRequest)
  }
}

/** Tap each of an exercise's `sets` set buttons once: each set done at the reps asked for. */
const tapEverySet = async (
  user: ReturnType<typeof userEvent.setup>,
  exerciseName: string,
  sets: number
): Promise<void> => {
  const group = screen.getByRole('group', { name: `${exerciseName} sets` })
  for (let set = 1; set <= sets; set++) {
    // oxlint-disable-next-line no-await-in-loop -- a lifter taps one set after another
    await user.click(
      within(group).getByRole('button', { name: `${exerciseName} set ${set}: not done` })
    )
  }
}

// ---------------------------------------------------------------------------
// Decoding what the server holds, as the app's readers decode it
// ---------------------------------------------------------------------------

const trainingPlanDefinitionWireSchema = Schema.compose(
  PlanDefinition.Schema,
  TrainingPlanDefinition.Schema
)
const exerciseRequestWireSchema = Schema.compose(ServiceRequest.Schema, ExerciseRequest.Schema)
const workoutProcedureWireSchema = Schema.compose(Procedure.Schema, WorkoutProcedure.Schema)
const exerciseSetObservationWireSchema = Schema.compose(
  Observation.Schema,
  ExerciseSetObservation.Schema
)

/** The resources of `resourceType` in one written batch, decoded through `schema`. */
const decodedOfType = <A, I>(
  batch: readonly unknown[] | undefined,
  resourceType: string,
  schema: Schema.Schema<A, I>
): readonly A[] =>
  (batch ?? [])
    .filter((wire) => resourceTypeOfWire(wire) === resourceType)
    .map((wire) => Schema.decodeUnknownSync(schema)(wire))

/** Each request's load value by exercise id. */
const loadsByExerciseId = (
  exerciseRequests: readonly ExerciseRequest.Type[]
): Readonly<Record<string, number>> =>
  Object.fromEntries(
    exerciseRequests.map((exerciseRequest) => [
      ExerciseConcept.idOf(ExerciseRequest.exerciseOf(exerciseRequest)),
      Load.valueOf(ExerciseRequest.loadOf(exerciseRequest)),
    ])
  )

/** Each starting load's value by exercise id. */
const loadsOf = (startingLoads: ExerciseRequest.StartingLoads): Readonly<Record<string, number>> =>
  Object.fromEntries(
    Object.entries(startingLoads).map(([exerciseId, load]) => [exerciseId, Load.valueOf(load)])
  )

// ---------------------------------------------------------------------------
// Mounting the app
// ---------------------------------------------------------------------------

/** Render `node` under StrictMode over a retry-free `QueryClient`, as `SmartAppRoot` would provide one. */
const renderWithQueryClient = (node: ReactNode, queryClient = testQueryClient()): void => {
  render(
    createElement(
      StrictMode,
      null,
      createElement(QueryClientProvider, { client: queryClient }, node)
    )
  )
}

const testQueryClient = (): QueryClient =>
  new QueryClient({ defaultOptions: { queries: { retry: false } } })

/**
 * Mount the lifting screens over `server`, through the real runtime, for
 * `patientChoice` — the lifter {@link PATIENT_ID} unless told otherwise.
 */
const mountLiftingApp = (
  server: FakeFhirServer,
  patientChoice: PatientChoice = LIFTER_CHOICE
): void => {
  const queryClient = testQueryClient()
  const { runAuthed } = buildSmartRouterContext(
    { serverUrl: SERVER_URL, accessToken: ACCESS_TOKEN },
    server.transport,
    queryClient
  )
  renderWithQueryClient(
    createElement(LiftingApp, {
      client: server.clientFor(PATIENT_ID),
      runAuthed,
      patientChoice,
      onPatientChange: () => undefined,
    }),
    queryClient
  )
}

export {
  decodedOfType,
  END_TO_END_TIMEOUT_MILLIS,
  endLiftingTest,
  exerciseRequestWireSchema,
  exerciseSetObservationWireSchema,
  liftingCategoryWire,
  loadsByExerciseId,
  loadsOf,
  mountLiftingApp,
  PATIENT_ID,
  renderWithQueryClient,
  SEEDED_PLAN_DEFINITION_ID,
  seededExerciseRequests,
  seedStartedLifter,
  seedWorkout,
  startLiftingTest,
  SUBJECT,
  SUBMITTED_AT,
  tapEverySet,
  trainingPlanDefinitionWireSchema,
  workoutProcedureWireSchema,
}
