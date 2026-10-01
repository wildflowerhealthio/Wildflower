import { HttpClient, HttpClientResponse, type HttpClientRequest } from '@effect/platform'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Array as Arr, DateTime, Effect, Layer, Option, Order, Schema } from 'effect'
import type * as FhirR4ReactSmart from 'fhir-r4-react/smart'
import type { SmartHandshake } from 'fhir-r4-react/smart'
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
import { type ReactNode, StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import type { SmartClient } from './smart-client.ts'

/**
 * The app's own wiring, end to end, over an in-memory FHIR server: reads go
 * through the real `fhir-r4-react/smart` page readers (over a stub fhirclient
 * client that answers searches from the server's store), writes through the
 * real `buildSmartRouterContext` and `persistBatchBundleOrFail` (over a stub
 * transport that applies batch `Bundle`s to the same store), and every
 * decision through the real `lifting-core`. Only the SMART handshake (which
 * needs a browser redirect) and `useLaunchFailureRedirect` (which would
 * navigate away) are stubbed.
 *
 * What only this layer can show: that what the screens hand back is what
 * lands on the server, and reads back as the record the next screen shows;
 * that a retry rewrites the same ids; that every write is addressed to the
 * FHIR base with the granted token; and that what the server holds but the
 * app cannot read is said, not dropped.
 */

const { handshakeMock } = vi.hoisted(() => ({
  handshakeMock: vi.fn<() => SmartHandshake>(),
}))
vi.mock('fhir-r4-react/smart', async (importOriginal) => ({
  ...(await importOriginal<typeof FhirR4ReactSmart>()),
  useSmartHandshake: () => handshakeMock(),
  useLaunchFailureRedirect: (): void => undefined,
}))

const { App } = await import('./app.tsx')
const { LiftingApp } = await import('./lifting-app.tsx')
const { LIFTING_SCOPE } = await import('./config.ts')

const SERVER_URL = 'http://127.0.0.1:8080/fhir-r4'
const ACCESS_TOKEN = 'tok-lift'
const PATIENT_ID = 'pat-1'
const SUBJECT = { reference: `Patient/${PATIENT_ID}` }
/** When every workout in these tests is submitted. */
const SUBMITTED_AT = '2026-09-28T18:30:00.000Z'

/** The StrongLifts 5×5 program a seeded lifter follows. */
const SEEDED_PLAN_DEFINITION_ID = 'pd-strong-lifts'
const seededTrainingPlanDefinition =
  StrongLifts5x5.trainingPlanDefinition(SEEDED_PLAN_DEFINITION_ID)

let server: FakeFhirServer

beforeEach(() => {
  server = fakeFhirServer()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(SUBMITTED_AT))
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  handshakeMock.mockReset()
})

describe('App', () => {
  it('should stop at a gate when the launch names no patient, reading and writing nothing', () => {
    // Arrange
    handshakeMock.mockReturnValue({ kind: 'ready', client: server.clientFor(null) })

    // Act
    renderWithQueryClient(<App />)

    // Assert
    expect(screen.getByText('Lifting needs a patient')).toBeDefined()
    expect(server.searches).toEqual([])
    expect(server.writes).toEqual([])
  })

  it('should mount the lifting screens for the patient the launch names', async () => {
    // Arrange
    seedStartedLifter()
    handshakeMock.mockReturnValue({ kind: 'ready', client: server.clientFor(PATIENT_ID) })

    // Act
    renderWithQueryClient(<App />)

    // Assert
    expect(await screen.findByRole('heading', { name: 'Workout A' })).toBeDefined()
    expect(screen.getByRole('heading', { name: 'Lifting', level: 1 })).toBeDefined()
  })
})

describe('LiftingApp', () => {
  it('should start StrongLifts 5×5 in one batch that reads back as its first workout', async () => {
    // Arrange — nothing on the server yet
    const user = userEvent.setup()
    mountLiftingApp()

    // Act
    await user.click(await screen.findByRole('button', { name: 'Start program' }))

    // Assert — the template and one request per lift, each at its starting load
    expect(await screen.findByRole('heading', { name: 'Workout A' })).toBeDefined()
    expect(server.writes).toHaveLength(1)
    const [trainingPlanDefinition] = decodedOfType(
      server.writes[0],
      'PlanDefinition',
      trainingPlanDefinitionWireSchema
    )
    expect(trainingPlanDefinition?.title).toBe('StrongLifts 5×5')
    const startedExerciseRequests = decodedOfType(
      server.writes[0],
      'ServiceRequest',
      exerciseRequestWireSchema
    )
    expect(loadsByExerciseId(startedExerciseRequests)).toStrictEqual(
      loadsOf(StrongLifts5x5.STARTING_LOADS)
    )
    for (const exerciseRequest of startedExerciseRequests) {
      expect(exerciseRequest.status).toBe('active')
      expect(ExerciseRequest.trainingPlanDefinitionUrlOf(exerciseRequest)).toBe(
        trainingPlanDefinition?.url
      )
    }
  })

  it('should write a submitted workout as one batch — the workout, each set and each moved request — and show its outcome', async () => {
    // Arrange
    const user = userEvent.setup()
    seedStartedLifter()
    mountLiftingApp()
    await screen.findByRole('heading', { name: 'Workout A' })

    // Act — every set of squat and bench press, none of barbell row
    await tapEverySet(user, 'Squat', 5)
    await tapEverySet(user, 'Bench Press', 5)
    await user.click(screen.getByRole('button', { name: 'Submit workout' }))

    // Assert — the outcome, then the next day once the lifter moves on
    expect(await screen.findByRole('heading', { name: 'Workout A done' })).toBeDefined()
    expect(server.writes).toHaveLength(1)
    const batch = server.writes[0]
    const [workoutProcedure] = decodedOfType(batch, 'Procedure', workoutProcedureWireSchema)
    expect(workoutProcedure?.status).toBe('completed')
    expect(
      Option.map(Option.fromNullable(workoutProcedure), (completed) =>
        Option.map(WorkoutProcedure.endOf(completed), DateTime.formatIso)
      )
    ).toEqual(Option.some(Option.some(SUBMITTED_AT)))
    const exerciseSetObservations = decodedOfType(
      batch,
      'Observation',
      exerciseSetObservationWireSchema
    )
    expect(exerciseSetObservations).toHaveLength(10)
    // Each exercise's sets tie on start, so their ids alone order them.
    for (const exerciseId of ['squat', 'bench-press']) {
      const setIds = exerciseSetObservations
        .filter((set) => ExerciseSetObservation.serviceRequestIdOf(set) === `sr-${exerciseId}`)
        .map(({ id }) => id)
      expect(setIds).toHaveLength(5)
      expect(setIds.toSorted()).toEqual(setIds)
      for (const id of setIds) expect(id).toMatch(/^[A-Za-z0-9\-.]{1,64}$/)
    }
    // The two met lifts close and move up; the row, with no set, is not written.
    const writtenExerciseRequests = decodedOfType(
      batch,
      'ServiceRequest',
      exerciseRequestWireSchema
    )
    expect(
      writtenExerciseRequests
        .filter(({ status }) => status === 'completed')
        .map(({ id }) => id)
        .toSorted()
    ).toEqual(['sr-bench-press', 'sr-squat'])
    expect(
      loadsByExerciseId(writtenExerciseRequests.filter(({ status }) => status === 'active'))
    ).toStrictEqual({ squat: 50, 'bench-press': 50 })
    expect(writtenExerciseRequests.some(({ id }) => id === 'sr-barbell-row')).toBe(false)

    await user.click(screen.getByRole('button', { name: 'Next workout' }))
    expect(await screen.findByRole('heading', { name: 'Workout B' })).toBeDefined()
    expect(screen.getByText('50 lb · 5×5')).toBeDefined()
  })

  it('should retry a partly rejected workout under the same ids, leaving one workout on the record', async () => {
    // Arrange — the first batch's first set is refused
    const user = userEvent.setup()
    seedStartedLifter()
    server.rejectOnce('Observation')
    mountLiftingApp()
    await screen.findByRole('heading', { name: 'Workout A' })
    await tapEverySet(user, 'Squat', 5)
    await user.click(screen.getByRole('button', { name: 'Submit workout' }))
    expect(await screen.findAllByText(/1 of 8 batch entries were rejected/)).not.toHaveLength(0)

    // Act — the same planned workout is still shown; submit it again
    expect(screen.getByRole('heading', { name: 'Workout A' })).toBeDefined()
    await user.click(screen.getByRole('button', { name: 'Submit workout' }))

    // Assert
    expect(await screen.findByRole('heading', { name: 'Workout A done' })).toBeDefined()
    expect(server.writes).toHaveLength(2)
    expect(server.writes.map(idsOf)).toEqual([idsOf(server.writes[0]), idsOf(server.writes[0])])
    expect(server.storedIds('Procedure')).toHaveLength(1)
    expect(server.storedIds('Observation')).toHaveLength(5)
  })

  it('should save an edited program as a new PlanDefinition, then restart on it in one batch at the current loads', async () => {
    // Arrange
    const user = userEvent.setup()
    seedStartedLifter()
    mountLiftingApp()
    await screen.findByRole('heading', { name: 'Workout A' })
    await user.click(screen.getByRole('button', { name: 'Plan' }))

    // Act — retitle the program and save it, then start it
    const title = await screen.findByLabelText('Title')
    await user.clear(title)
    await user.type(title, 'My 5×5')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await user.click(await screen.findByRole('button', { name: 'Start program' }))

    // Assert — the saved definition is new; the old one is left as it was
    expect(await screen.findByRole('heading', { name: 'Workout A' })).toBeDefined()
    expect(server.writes).toHaveLength(2)
    const [savedTrainingPlanDefinition] = decodedOfType(
      server.writes[0],
      'PlanDefinition',
      trainingPlanDefinitionWireSchema
    )
    expect(server.writes[0]).toHaveLength(1)
    expect(savedTrainingPlanDefinition?.title).toBe('My 5×5')
    expect(savedTrainingPlanDefinition?.id).not.toBe(SEEDED_PLAN_DEFINITION_ID)
    expect(server.storedIds('PlanDefinition')).toHaveLength(2)
    // One batch revokes every active request and starts one per exercise.
    const changedExerciseRequests = decodedOfType(
      server.writes[1],
      'ServiceRequest',
      exerciseRequestWireSchema
    )
    expect(
      changedExerciseRequests
        .filter(({ status }) => status === 'revoked')
        .map(({ id }) => id)
        .toSorted()
    ).toEqual(
      seededExerciseRequests()
        .map(({ id }) => id)
        .toSorted()
    )
    const startedExerciseRequests = changedExerciseRequests.filter(
      ({ status }) => status === 'active'
    )
    expect(loadsByExerciseId(startedExerciseRequests)).toStrictEqual(
      loadsOf(StrongLifts5x5.STARTING_LOADS)
    )
    for (const exerciseRequest of startedExerciseRequests) {
      expect(ExerciseRequest.trainingPlanDefinitionUrlOf(exerciseRequest)).toBe(
        savedTrainingPlanDefinition?.url
      )
    }
  })

  it('should list a completed workout in the history, read with closed requests', async () => {
    // Arrange — one workout done, every lift met
    const user = userEvent.setup()
    seedStartedLifter()
    seedWorkout({ squat: [5, 5, 5, 5, 5], 'bench-press': [5, 5, 5, 5, 5] })
    mountLiftingApp()
    await screen.findByRole('heading', { name: 'Workout B' })

    // Act
    await user.click(screen.getByRole('button', { name: 'History' }))

    // Assert
    expect(await screen.findByText(/^Workout A · /)).toBeDefined()
    const serviceRequestSearches = server.searches
      .filter((query) => resourceTypeOfQuery(query) === 'ServiceRequest')
      .map(searchParamsOf)
    expect(serviceRequestSearches.some((params) => !params.has('status'))).toBe(true)
  })

  it('should read the sets with one search per active request, however many workouts there are', async () => {
    // Arrange — three workouts on the record
    seedStartedLifter()
    seedWorkout({ squat: [5, 5, 5, 5, 5] })
    seedWorkout({ squat: [5, 5, 5, 5, 5] })
    seedWorkout({ squat: [5, 5, 5, 5, 5] })

    // Act
    mountLiftingApp()
    await screen.findByRole('heading', { name: 'Workout B' })

    // Assert — the five lifts' requests, and no workout's
    const observationSearches = server.searches
      .filter((query) => resourceTypeOfQuery(query) === 'Observation')
      .map(searchParamsOf)
      .filter((params) => params.has('based-on') || params.has('part-of'))
    expect(observationSearches.every((params) => !params.has('part-of'))).toBe(true)
    expect(new Set(observationSearches.map((params) => params.get('based-on'))).size).toBe(5)
  })

  it('should count what it could not read, leaving a retracted set out without counting it', async () => {
    // Arrange — a lifting request that is no exercise request, a malformed set
    // and a retracted one
    seedStartedLifter()
    server.seedWire({
      resourceType: 'ServiceRequest',
      id: 'sr-not-an-exercise',
      status: 'active',
      intent: 'plan',
      category: [liftingCategoryWire],
      subject: SUBJECT,
    })
    server.seedWire({
      resourceType: 'Observation',
      id: 'set-malformed',
      status: 'final',
      code: { text: 'Squat' },
      subject: SUBJECT,
      basedOn: [{ reference: 'ServiceRequest/sr-squat' }],
    })
    server.seedWire({
      resourceType: 'Observation',
      id: 'set-retracted',
      status: 'entered-in-error',
      code: { text: 'Squat' },
      subject: SUBJECT,
      basedOn: [{ reference: 'ServiceRequest/sr-squat' }],
    })

    // Act
    mountLiftingApp()

    // Assert
    expect(
      await screen.findByText(
        '1 exercise request and 1 set on your record could not be read and are left out.'
      )
    ).toBeDefined()
    expect(screen.getByRole('heading', { name: 'Workout A' })).toBeDefined()
  })

  it('should offer a new start when the program the requests follow is not on the server', async () => {
    // Arrange — the requests, but not the PlanDefinition they instantiate
    for (const exerciseRequest of seededExerciseRequests()) server.seedResource(exerciseRequest)

    // Act
    mountLiftingApp()

    // Assert
    expect(
      await screen.findByText(
        /Your exercise requests follow a program \(.+\) that could not be found/
      )
    ).toBeDefined()
    expect(screen.getByRole('button', { name: 'Start program' })).toBeDefined()
  })

  it('should address every write to the FHIR server the handshake named, with the granted token', async () => {
    // Arrange
    const user = userEvent.setup()
    mountLiftingApp()

    // Act
    await user.click(await screen.findByRole('button', { name: 'Start program' }))
    await screen.findByRole('heading', { name: 'Workout A' })

    // Assert
    expect(server.requests).toEqual([
      { url: `${SERVER_URL}/`, authorization: `Bearer ${ACCESS_TOKEN}` },
    ])
  })

  it('should search and write only the resource types its requested scopes grant', async () => {
    // Arrange — a start, a workout and the history: every read and write the app makes
    const user = userEvent.setup()
    mountLiftingApp()
    await user.click(await screen.findByRole('button', { name: 'Start program' }))
    await screen.findByRole('heading', { name: 'Workout A' })
    await tapEverySet(user, 'Squat', 5)
    await user.click(screen.getByRole('button', { name: 'Submit workout' }))
    await user.click(await screen.findByRole('button', { name: 'Next workout' }))
    await user.click(screen.getByRole('button', { name: 'History' }))
    await screen.findByText(/^Workout A · /)

    // Assert
    const searchedTypes = new Set(server.searches.map(resourceTypeOfQuery))
    const writtenTypes = new Set(server.writes.flat().map(resourceTypeOfWire))
    expect([...searchedTypes].toSorted()).toEqual(
      ['Observation', 'PlanDefinition', 'Procedure', 'ServiceRequest'].toSorted()
    )
    for (const resourceType of searchedTypes) expect(grantedTypes('s')).toContain(resourceType)
    for (const resourceType of writtenTypes) {
      expect(grantedTypes('c')).toContain(resourceType)
      expect(grantedTypes('u')).toContain(resourceType)
    }
  })

  it('should disable every control while a write is in flight', async () => {
    // Arrange
    const user = userEvent.setup()
    const release = server.holdWrites()
    mountLiftingApp()

    // Act
    await user.click(await screen.findByRole('button', { name: 'Start program' }))

    // Assert
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Starting…' }).closest('fieldset')?.disabled).toBe(
        true
      )
    })
    release()
    expect(await screen.findByRole('heading', { name: 'Workout A' })).toBeDefined()
  })

  it('should show a failed read as such, not as an empty record', async () => {
    // Arrange
    server.failSearches()

    // Act
    mountLiftingApp()

    // Assert
    expect(await screen.findByText(/^Could not load your training: /)).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Start program' })).toBeNull()
  })
})

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
const seedStartedLifter = (): void => {
  server.seedResource(seededTrainingPlanDefinition)
  for (const exerciseRequest of seededExerciseRequests()) server.seedResource(exerciseRequest)
}

/** How many workouts {@link seedWorkout} has seeded, so each starts a day after the last. */
let seededWorkoutCount = 0

beforeEach(() => {
  seededWorkoutCount = 0
})

/**
 * Seed the workout due next as `PlannedWorkout.submit` writes it, with
 * `setRepsByExerciseId`, from what the server holds.
 */
const seedWorkout = (setRepsByExerciseId: PlannedWorkout.SetRepsByExerciseId): void => {
  const index = seededWorkoutCount
  seededWorkoutCount += 1
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

/** The codings of a concept the fake server searches on. */
const CodeableConceptFields = Schema.Struct({
  coding: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          system: Schema.optional(Schema.NullOr(Schema.String)),
          code: Schema.optional(Schema.NullOr(Schema.String)),
        })
      )
    )
  ),
})

/** The literal reference of a reference the fake server searches on. */
const ReferenceFields = Schema.Struct({ reference: Schema.optional(Schema.NullOr(Schema.String)) })

/** The fields of a stored resource the fake server searches on. */
const StoredResourceFields = Schema.Struct({
  resourceType: Schema.String,
  id: Schema.String,
  status: Schema.optional(Schema.NullOr(Schema.String)),
  subject: Schema.optional(
    Schema.NullOr(Schema.Struct({ reference: Schema.optional(Schema.NullOr(Schema.String)) }))
  ),
  // An array on most resources; one concept on a `Procedure`.
  category: Schema.optional(
    Schema.NullOr(Schema.Union(Schema.Array(CodeableConceptFields), CodeableConceptFields))
  ),
  topic: Schema.optional(Schema.NullOr(Schema.Array(CodeableConceptFields))),
  instantiatesCanonical: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  basedOn: Schema.optional(Schema.NullOr(Schema.Array(ReferenceFields))),
  partOf: Schema.optional(Schema.NullOr(Schema.Array(ReferenceFields))),
})
type StoredResourceFields = typeof StoredResourceFields.Type

const fieldsOf = (wire: unknown): StoredResourceFields =>
  Schema.decodeUnknownSync(StoredResourceFields)(wire)

const resourceTypeOfWire = (wire: unknown): string => fieldsOf(wire).resourceType

const idsOf = (batch: readonly unknown[] | undefined): readonly string[] =>
  (batch ?? []).map((wire) => fieldsOf(wire).id)

/** The resource type a search query names, relative or absolute. */
const resourceTypeOfQuery = (query: string): string => {
  const relative = query.startsWith(`${SERVER_URL}/`) ? query.slice(SERVER_URL.length + 1) : query
  return relative.split('?')[0] ?? ''
}

const searchParamsOf = (query: string): URLSearchParams =>
  new URLSearchParams(query.slice(query.indexOf('?') + 1))

/**
 * The resource types `LIFTING_SCOPE` grants `permission` on (a SMART v2
 * letter: `s` search, `c` create, `u` update), read off the string itself.
 */
const grantedTypes = (permission: string): readonly string[] =>
  LIFTING_SCOPE.split(' ').flatMap((scope) => {
    const [, resourceType, permissions] = /^system\/(\w+)\.([cruds]+)$/.exec(scope) ?? []
    return resourceType !== undefined && permissions?.includes(permission) ? [resourceType] : []
  })

// ---------------------------------------------------------------------------
// The in-memory FHIR server
// ---------------------------------------------------------------------------

/** The request entries of a batch `Bundle` the transport receives. */
const BatchBundle = Schema.parseJson(
  Schema.Struct({
    entry: Schema.Array(
      Schema.Struct({
        request: Schema.Struct({ method: Schema.String, url: Schema.String }),
        resource: Schema.Unknown,
      })
    ),
  })
)

/** One write request the transport saw. */
interface RecordedRequest {
  readonly url: string
  readonly authorization: string | undefined
}

interface FakeFhirServer {
  /** Every search query the readers issued, in order. */
  readonly searches: string[]
  /** Every request that reached the transport (the batch writes), in order. */
  readonly requests: RecordedRequest[]
  /** Every batch `Bundle`'s resources, one array per batch, in order. */
  readonly writes: (readonly unknown[])[]
  readonly transport: Layer.Layer<HttpClient.HttpClient>
  readonly clientFor: (patientId: string | null) => SmartClient
  readonly seedWire: (wire: unknown) => void
  /** Store a decoded resource as the app writes one: its JSON. */
  readonly seedResource: (resource: unknown) => void
  /** Every stored resource of `resourceType`, decoded through `schema`. */
  readonly stored: <A, I>(resourceType: string, schema: Schema.Schema<A, I>) => readonly A[]
  /** Refuse the first entry of `resourceType` the next batch carries, once. */
  readonly rejectOnce: (resourceType: string) => void
  /** Hold every batch's response until the returned function is called. */
  readonly holdWrites: () => () => void
  /** Fail every search from now on. */
  readonly failSearches: () => void
  /** The ids of the stored resources of `resourceType`, sorted. */
  readonly storedIds: (resourceType: string) => readonly string[]
}

/** How many entries the fake server puts on one search page — small, so paging is exercised. */
const PAGE_SIZE = 2

/** The `system|code` tokens a concept list carries. */
const tokensOf = (concepts: StoredResourceFields['category']): readonly string[] =>
  (concepts === undefined || concepts === null ? [] : Arr.ensure(concepts)).flatMap((concept) =>
    (concept.coding ?? []).map((coding) => `${coding.system ?? ''}|${coding.code ?? ''}`)
  )

/** The literal references a reference list carries. */
const referencesOf = (references: StoredResourceFields['basedOn']): readonly string[] =>
  (references ?? []).flatMap(({ reference }) =>
    reference === undefined || reference === null ? [] : [reference]
  )

/**
 * Whether a stored resource matches a search: `patient`, `status`,
 * `category`, `topic`, `instantiates-canonical`, `based-on` and `part-of`
 * honoured.
 */
const matches = (fields: StoredResourceFields, params: URLSearchParams): boolean => {
  const matchesParam = (name: string, values: readonly string[]): boolean => {
    const wanted = params.get(name)
    return wanted === null || values.includes(wanted)
  }
  return (
    matchesParam('patient', [fields.subject?.reference?.replace(/^Patient\//, '') ?? '']) &&
    matchesParam('status', [fields.status ?? '']) &&
    matchesParam('category', tokensOf(fields.category)) &&
    matchesParam('topic', tokensOf(fields.topic)) &&
    matchesParam('instantiates-canonical', fields.instantiatesCanonical ?? []) &&
    matchesParam('based-on', referencesOf(fields.basedOn)) &&
    matchesParam('part-of', referencesOf(fields.partOf))
  )
}

/**
 * An in-memory FHIR server: searches answered from its store, paged at
 * {@link PAGE_SIZE} with a `next` link; batch `Bundle`s applied to it entry by
 * entry.
 */
const fakeFhirServer = (): FakeFhirServer => {
  const store = new Map<string, unknown>()
  const searches: string[] = []
  const requests: RecordedRequest[] = []
  const writes: (readonly unknown[])[] = []
  let rejectOnceType: string | null = null
  let held: Promise<void> = Promise.resolve()
  let searchesFail = false

  const seedWire = (wire: unknown): void => {
    const fields = fieldsOf(wire)
    store.set(`${fields.resourceType}/${fields.id}`, wire)
  }

  const searchset = (query: string): unknown => {
    searches.push(query)
    const resourceType = resourceTypeOfQuery(query)
    const params = searchParamsOf(query)
    const offset = Number(params.get('_offset') ?? '0')
    const found = [...store.values()].filter((wire) => {
      const fields = fieldsOf(wire)
      return fields.resourceType === resourceType && matches(fields, params)
    })
    params.set('_offset', String(offset + PAGE_SIZE))
    return {
      resourceType: 'Bundle',
      type: 'searchset',
      entry: found.slice(offset, offset + PAGE_SIZE).map((resource) => ({ resource })),
      link:
        offset + PAGE_SIZE < found.length
          ? [{ relation: 'next', url: `${SERVER_URL}/${resourceType}?${params.toString()}` }]
          : [],
    }
  }

  const clientFor = (patientId: string | null): SmartClient => {
    const stub = {
      request: (query: string): Promise<unknown> =>
        searchesFail
          ? Promise.reject(new Error('search refused by test server'))
          : Promise.resolve(searchset(query)),
      patient: { id: patientId },
      state: { serverUrl: SERVER_URL, tokenResponse: { access_token: ACCESS_TOKEN } },
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test-only stub: the app reads `request`, `patient.id` and `state`
    return stub as unknown as SmartClient
  }

  const transport = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      requests.push({ url: request.url, authorization: request.headers['authorization'] })
      const bundle = Schema.decodeUnknownSync(BatchBundle)(decodeBody(request.body))
      writes.push(bundle.entry.map((entry) => entry.resource))
      const responses = bundle.entry.map((entry) => {
        const entryType = entry.request.url.split('/')[0] ?? ''
        if (rejectOnceType === entryType) {
          rejectOnceType = null
          return { response: { status: '422 Unprocessable Entity' } }
        }
        seedWire(entry.resource)
        return { response: { status: '201 Created' } }
      })
      const gate = held
      return Effect.promise(() => gate).pipe(
        Effect.as(
          HttpClientResponse.fromWeb(
            request,
            new Response(
              JSON.stringify({ resourceType: 'Bundle', type: 'batch-response', entry: responses }),
              { status: 200, headers: { 'content-type': 'application/fhir+json' } }
            )
          )
        )
      )
    })
  )

  return {
    searches,
    requests,
    writes,
    transport,
    clientFor,
    seedWire,
    seedResource: (resource) => {
      seedWire(JSON.parse(JSON.stringify(resource)))
    },
    stored: (resourceType, schema) =>
      Arr.filterMap([...store.values()], (wire) =>
        resourceTypeOfWire(wire) === resourceType
          ? Option.some(Schema.decodeUnknownSync(schema)(wire))
          : Option.none()
      ),
    rejectOnce: (resourceType) => {
      rejectOnceType = resourceType
    },
    holdWrites: () => {
      let release: () => void = () => undefined
      held = new Promise((resolve) => {
        release = resolve
      })
      return () => {
        release()
        held = Promise.resolve()
      }
    },
    failSearches: () => {
      searchesFail = true
    },
    storedIds: (resourceType) =>
      [...store.values()]
        .map(fieldsOf)
        .filter((fields) => fields.resourceType === resourceType)
        .map(({ id }) => id)
        .toSorted(Order.string),
  }
}

const decodeBody = (body: HttpClientRequest.HttpClientRequest['body']): string =>
  body._tag === 'Uint8Array' ? new TextDecoder().decode(body.body) : ''

/** Render `node` under StrictMode over a retry-free `QueryClient`, as `SmartAppRoot` would provide one. */
const renderWithQueryClient = (node: ReactNode, queryClient = testQueryClient()): void => {
  render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>
    </StrictMode>
  )
}

const testQueryClient = (): QueryClient =>
  new QueryClient({ defaultOptions: { queries: { retry: false } } })

/** Mount the lifting screens for {@link PATIENT_ID} over the fake server, through the real runtime. */
const mountLiftingApp = (): void => {
  const queryClient = testQueryClient()
  const { runAuthed } = buildSmartRouterContext(
    { serverUrl: SERVER_URL, accessToken: ACCESS_TOKEN },
    server.transport,
    queryClient
  )
  renderWithQueryClient(
    <LiftingApp
      client={server.clientFor(PATIENT_ID)}
      patientId={PATIENT_ID}
      runAuthed={runAuthed}
    />,
    queryClient
  )
}
