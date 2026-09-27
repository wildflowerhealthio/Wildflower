import { HttpClient, HttpClientResponse, type HttpClientRequest } from '@effect/platform'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import {
  Array as Arr,
  DateTime,
  Effect,
  Either,
  Layer,
  Option,
  Order,
  Record,
  Schema,
} from 'effect'
import type * as FhirR4ReactSmart from 'fhir-r4-react/smart'
import type { SmartHandshake } from 'fhir-r4-react/smart'
import { buildSmartRouterContext } from 'fhir-r4-react/smart'
import { CarePlan, Goal, Observation } from 'fhir-r4/resources'
import type Client from 'fhirclient/lib/Client'
import {
  type ExerciseAttempt,
  goalsFor,
  type Plan,
  progressPlan,
  strongLifts5x5,
} from 'lifting-core'
import {
  attemptFromFhir,
  attemptToFhir,
  exerciseGoalFromFhir,
  LIFTING_PLAN_CATEGORY_TOKEN,
  planFromFhir,
  planToFhir,
} from 'lifting-core/fhir'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

/**
 * The app's own wiring, end to end, over an in-memory FHIR server: reads go
 * through the real `fhir-r4-react/smart` page readers (over a stub fhirclient
 * `Client` that answers searches from the server's store), writes through the
 * real `buildSmartRouterContext` and `persistBatchBundle` (over a stub
 * transport that applies batch `Bundle`s to the same store), and every mapping
 * through the real `lifting-core/fhir` adapters. Only the SMART handshake
 * (`useSmartHandshake`, which needs a browser redirect) and
 * `useLaunchFailureRedirect` (which would navigate away) are stubbed.
 *
 * What only this layer can show: that what the views hand back is what lands
 * on the server — a saved plan's `CarePlan` + `Goal`s read back to the plan, a
 * logged session's `Observation`s read back to the attempts, a progression
 * rewrites only the moved goals under their stored ids — that every write is
 * addressed to the FHIR base with the granted token, and that what the server
 * holds but the app cannot use is said, not dropped.
 */

const { handshakeMock } = vi.hoisted(() => ({
  handshakeMock: vi.fn<() => SmartHandshake>(),
}))
vi.mock('fhir-r4-react/smart', async (importOriginal) => ({
  ...(await importOriginal<typeof FhirR4ReactSmart>()),
  useSmartHandshake: () => handshakeMock(),
  useLaunchFailureRedirect: (): void => undefined,
}))

const { App, LiftingApp } = await import('./app.tsx')
const { smartConfig } = await import('./config.ts')

const SERVER_URL = 'http://127.0.0.1:8080/fhir-r4'
const ACCESS_TOKEN = 'tok-lift'
const PATIENT_ID = 'pat-1'
const PERFORMED_AT = '2026-09-26T14:30:00.000Z'

/** The ids a seeded plan's resources are stored under. */
const SEEDED_CARE_PLAN_ID = 'plan-1'
const seededGoalIdFor = (exerciseId: string): string => `goal-${exerciseId}`
const SEEDED_CREATED = '2026-09-01T09:00:00.000Z'

/** The lifting plan `category`, as a hand-written `CarePlan` wire carries it. */
const [liftingCategorySystem = '', liftingCategoryCode = ''] =
  LIFTING_PLAN_CATEGORY_TOKEN.split('|')
const liftingCategoryWire = {
  coding: [{ system: liftingCategorySystem, code: liftingCategoryCode }],
}

let server: FakeFhirServer

beforeEach(() => {
  server = fakeFhirServer()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(PERFORMED_AT))
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
    expect(screen.queryByRole('heading', { name: 'Lifting', level: 1 })).toBeNull()
    expect(server.searches).toHaveLength(0)
    expect(server.requests).toHaveLength(0)
  })

  it('should mount the lifting screens for the patient the launch names', async () => {
    // Arrange
    server.seedPlan(strongLifts5x5())
    handshakeMock.mockReturnValue({ kind: 'ready', client: server.clientFor(PATIENT_ID) })

    // Act
    renderWithQueryClient(<App />)

    // Assert
    expect(await screen.findByRole('heading', { name: 'Workout A' })).toBeDefined()
    expect(screen.getByRole('heading', { name: 'Lifting', level: 1 })).toBeDefined()
  })
})

describe('LiftingApp', () => {
  it('should save a StrongLifts plan as a CarePlan and Goals that read back to that plan', async () => {
    // Arrange — nothing on the server yet
    mountLiftingApp()
    await userEvent.click(await screen.findByRole('button', { name: 'Create a plan' }))

    // Act — seed the editor from the template and save it
    await userEvent.click(screen.getByRole('button', { name: 'Start from StrongLifts 5×5' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save plan' }))

    // Assert — one batch, which reads back to the plan the editor was seeded with
    await screen.findByRole('heading', { name: 'Workout A' })
    const [written] = server.batches
    expect(server.batches).toHaveLength(1)
    const carePlans = decodedOfType(written, 'CarePlan', CarePlan.Schema)
    const goals = decodedOfType(written, 'Goal', Goal.Schema)
    expect(carePlans).toHaveLength(1)
    expect(goals).toHaveLength(Record.size(strongLifts5x5().goalsByExerciseId))
    const [carePlan] = carePlans
    expect(carePlan?.subject.reference).toBe(`Patient/${PATIENT_ID}`)
    expect(goals.every((goal) => goal.subject.reference === `Patient/${PATIENT_ID}`)).toBe(true)
    const stored = carePlan === undefined ? undefined : planFromFhir(carePlan, goals)
    expect(stored && Either.map(stored, (read) => read.plan)).toStrictEqual(
      Either.right(strongLifts5x5())
    )
    // Stamped with the save's time, so the newest plan can be told apart.
    expect(
      stored && Either.map(stored, (read) => Option.map(read.created, DateTime.formatIso))
    ).toStrictEqual(Either.right(Option.some(PERFORMED_AT)))
  })

  it('should rewrite an edited plan in place, under its stored CarePlan and Goal ids', async () => {
    // Arrange
    server.seedPlan(strongLifts5x5())
    mountLiftingApp()
    await userEvent.click(await screen.findByRole('button', { name: 'Plan' }))

    // Act — change the title and save
    const title = screen.getByRole('textbox', { name: 'Title' })
    await userEvent.clear(title)
    await userEvent.type(title, 'My 5×5')
    await userEvent.click(screen.getByRole('button', { name: 'Save plan' }))

    // Assert — the same ids, so nothing new appears beside the stored plan
    await screen.findByRole('heading', { name: 'Workout A' })
    const [written] = server.batches
    expect(decodedOfType(written, 'CarePlan', CarePlan.Schema).map((plan) => plan.id)).toEqual([
      SEEDED_CARE_PLAN_ID,
    ])
    expect(
      decodedOfType(written, 'Goal', Goal.Schema)
        .flatMap((goal) => (goal.id === null ? [] : [goal.id]))
        .toSorted(Order.string)
    ).toEqual(
      Record.keys(strongLifts5x5().goalsByExerciseId).map(seededGoalIdFor).toSorted(Order.string)
    )
  })

  it("should log a session as Observations that read back to the attempts the today view built, based on the plan's CarePlan", async () => {
    // Arrange
    const plan = strongLifts5x5()
    server.seedPlan(plan)
    mountLiftingApp()
    await screen.findByRole('heading', { name: 'Workout A' })

    // Act — miss one rep on the first squat set, then log the session
    await userEvent.click(screen.getByRole('button', { name: 'Squat set 1: 5 of 5 reps' }))
    await userEvent.click(screen.getByRole('button', { name: 'Log session' }))

    // Assert — one Observation per exercise of workout A, reading back to
    // exactly what was performed
    await screen.findByRole('heading', { name: 'Progression' })
    const [written] = server.batches
    const observations = decodedOfType(written, 'Observation', Observation.Schema)
    const [firstWorkout] = plan.workouts
    const expected = goalsFor(plan, firstWorkout).map((goal): ExerciseAttempt => ({
      exercise: goal.exercise,
      workoutLabel: firstWorkout.label,
      performedAt: DateTime.unsafeMake(PERFORMED_AT),
      loadLb: goal.loadLb,
      prescribedSets: goal.sets,
      prescribedReps: goal.reps,
      repsCompleted: Arr.replicate(goal.reps, goal.sets).map((reps, setIndex) =>
        goal.exercise.id === 'squat' && setIndex === 0 ? reps - 1 : reps
      ),
    }))
    expect(observations.map(readAttempt)).toStrictEqual(expected.map(comparableAttempt))
    for (const observation of observations) {
      expect(observation.basedOn.map((reference) => reference.reference)).toEqual([
        `CarePlan/${SEEDED_CARE_PLAN_ID}`,
      ])
      expect(observation.subject?.reference).toBe(`Patient/${PATIENT_ID}`)
    }
    expect(observations.map((observation) => observation.focus[0]?.reference)).toEqual(
      expected.map((attempt) => `Goal/${seededGoalIdFor(attempt.exercise.id)}`)
    )
    // Every Observation gets its own freshly minted id.
    expect(new Set(observations.map((observation) => observation.id)).size).toBe(expected.length)
  })

  it('should address every write to the FHIR server the handshake named, with the granted token', async () => {
    // Arrange
    server.seedPlan(strongLifts5x5())
    mountLiftingApp()
    await screen.findByRole('heading', { name: 'Workout A' })

    // Act
    await userEvent.click(screen.getByRole('button', { name: 'Log session' }))
    await screen.findByRole('heading', { name: 'Progression' })

    // Assert
    expect(server.requests.length).toBeGreaterThan(0)
    for (const request of server.requests) {
      expect(request.url).toBe(`${SERVER_URL}/`)
      expect(request.authorization).toBe(`Bearer ${ACCESS_TOKEN}`)
    }
  })

  it('should apply a progression by rewriting only the goals whose load moved, in place', async () => {
    // Arrange — workout A logged in full at every goal's load
    const plan = strongLifts5x5()
    server.seedPlan(plan)
    const [firstWorkout] = plan.workouts
    const loggedAttempts = goalsFor(plan, firstWorkout).map((goal): ExerciseAttempt => ({
      exercise: goal.exercise,
      workoutLabel: firstWorkout.label,
      performedAt: DateTime.unsafeMake('2026-09-24T14:30:00.000Z'),
      loadLb: goal.loadLb,
      prescribedSets: goal.sets,
      prescribedReps: goal.reps,
      repsCompleted: Arr.replicate(goal.reps, goal.sets),
    }))
    server.seedAttempts(loggedAttempts)
    mountLiftingApp()
    await userEvent.click(await screen.findByRole('button', { name: 'Progress' }))

    // Act
    await userEvent.click(await screen.findByRole('button', { name: 'Apply progression' }))

    // Assert — only workout A's goals, each under its stored id at its progressed load
    await screen.findByText('Every load holds — there is nothing to apply.')
    const [written] = server.batches
    const progressed = progressPlan(plan, loggedAttempts)
    const writtenGoals = decodedOfType(written, 'Goal', Goal.Schema)
    expect(decodedOfType(written, 'CarePlan', CarePlan.Schema)).toHaveLength(0)
    expect(
      writtenGoals.map((goal) => [goal.id, Either.map(exerciseGoalFromFhir(goal), (g) => g.loadLb)])
    ).toStrictEqual(
      loggedAttempts.map((attempt) => [
        seededGoalIdFor(attempt.exercise.id),
        Either.right(progressed.goalsByExerciseId[attempt.exercise.id]?.loadLb),
      ])
    )
  })

  it('should show a rejected write in the view that made it, and keep the plan as stored', async () => {
    // Arrange — the server refuses every entry
    server.seedPlan(strongLifts5x5())
    server.rejectWrites()
    mountLiftingApp()
    await screen.findByRole('heading', { name: 'Workout A' })

    // Act
    await userEvent.click(screen.getByRole('button', { name: 'Log session' }))

    // Assert — the failure is announced on Today, which stays up to retry
    expect(await screen.findByText(/3 of 3 writes were rejected/)).toBeDefined()
    // Each rejected entry is named by its target and the status the server gave it.
    expect(
      screen.getByText(
        /Observation\/[\w-]+ \(422 Unprocessable Entity: Observation rejected by test server\)/
      )
    ).toBeDefined()
    expect(screen.getByRole('heading', { name: 'Workout A' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Log session' })).toHaveProperty('disabled', false)

    // Act — retry once the server accepts writes again
    server.acceptWrites()
    await userEvent.click(screen.getByRole('button', { name: 'Log session' }))

    // Assert — the retry wrote the same Observation ids, so nothing is doubled
    await screen.findByRole('heading', { name: 'Progression' })
    const [refused = [], retried = []] = server.batches
    expect(idsOf(retried)).toEqual(idsOf(refused))
    expect(server.storedIds('Observation')).toHaveLength(3)
  })

  it('should complete a partly rejected first save on retry, under the same ids, leaving one plan', async () => {
    // Arrange — the server refuses one Goal of the first save, once
    mountLiftingApp()
    await userEvent.click(await screen.findByRole('button', { name: 'Create a plan' }))
    await userEvent.click(screen.getByRole('button', { name: 'Start from StrongLifts 5×5' }))
    server.rejectOnce('Goal')

    // Act — save; the CarePlan and four Goals land, one Goal does not
    await userEvent.click(screen.getByRole('button', { name: 'Save plan' }))

    // Assert — the refetched record shows what landed (a plan it cannot read
    // yet), and the error names the rejected Goal
    expect(await screen.findByText(/1 active plan on your record could not be read/)).toBeDefined()
    const [firstSave = []] = server.batches
    const rejectedGoalId = decodedOfType(firstSave, 'Goal', Goal.Schema)[0]?.id ?? ''
    expect(
      screen.getByText(new RegExp(`Goal/${rejectedGoalId} \\(422 Unprocessable Entity`))
    ).toBeDefined()

    // Act — retry the same draft
    await userEvent.click(screen.getByRole('button', { name: 'Save plan' }))

    // Assert — the retry wrote the same ids, so the record holds one plan and
    // its five goals, and it now reads
    expect(await screen.findByRole('heading', { name: 'Workout A' })).toBeDefined()
    const [, retry = []] = server.batches
    expect(idsOf(retry)).toEqual(idsOf(firstSave))
    expect(server.storedIds('CarePlan')).toHaveLength(1)
    expect(server.storedIds('Goal')).toEqual(
      decodedOfType(firstSave, 'Goal', Goal.Schema)
        .flatMap((goal) => (goal.id === null ? [] : [goal.id]))
        .toSorted(Order.string)
    )
    expect(screen.queryByText(/could not be read/)).toBeNull()
  })

  it('should show what a partly rejected session landed, naming the entry that did not', async () => {
    // Arrange — the server refuses the session's first Observation (the squat), once
    server.seedPlan(strongLifts5x5())
    mountLiftingApp()
    await screen.findByRole('heading', { name: 'Workout A' })
    server.rejectOnce('Observation')

    // Act
    await userEvent.click(screen.getByRole('button', { name: 'Log session' }))

    // Assert — the refetch shows the two attempts that landed (workout A was
    // logged, so B is due), and the error names the rejected squat
    expect(await screen.findByRole('heading', { name: 'Workout B' })).toBeDefined()
    const [written = []] = server.batches
    const [rejected, ...landed] = decodedOfType(written, 'Observation', Observation.Schema)
    expect(
      screen.getByText(
        new RegExp(`1 of 3 writes were rejected: Observation/${rejected?.id ?? ''} \\(422`)
      )
    ).toBeDefined()
    expect(server.storedIds('Observation')).toEqual(
      landed
        .flatMap((observation) => (observation.id === null ? [] : [observation.id]))
        .toSorted(Order.string)
    )
  })

  it('should disable every view while a write is in flight', async () => {
    // Arrange — the server holds its answer
    server.seedPlan(strongLifts5x5())
    const release = server.holdWrites()
    mountLiftingApp()
    await screen.findByRole('heading', { name: 'Workout A' })

    // Act — log a session, and while it is pending open the plan editor
    await userEvent.click(screen.getByRole('button', { name: 'Log session' }))
    await userEvent.click(screen.getByRole('button', { name: 'Plan' }))

    // Assert — the editor cannot save over the pending write
    const title = screen.getByRole('textbox', { name: 'Title' })
    expect(title.matches(':disabled')).toBe(true)
    expect(screen.getByRole('button', { name: /Saving…|Save plan/ }).matches(':disabled')).toBe(
      true
    )

    // Act — let the write land
    release()

    // Assert — the editor is live again once it has
    await screen.findByRole('heading', { name: 'Progression' })
    await userEvent.click(screen.getByRole('button', { name: 'Plan' }))
    expect(screen.getByRole('textbox', { name: 'Title' }).matches(':disabled')).toBe(false)
  })

  it('should show a failed read as an error, not an empty plan', async () => {
    // Arrange
    server.seedPlan(strongLifts5x5())
    server.failSearches()

    // Act
    mountLiftingApp()

    // Assert
    expect((await screen.findByRole('alert')).textContent).toContain('ResourcePageRequestError')
    expect(screen.queryByRole('button', { name: 'Create a plan' })).toBeNull()
  })

  it("should not read another feature's care plans as lifting plans", async () => {
    // Arrange — an active CarePlan with no lifting category beside the plan
    server.seedPlan(strongLifts5x5())
    server.seedWire({
      resourceType: 'CarePlan',
      id: 'diabetes-plan',
      status: 'active',
      intent: 'plan',
      title: 'Diabetes care',
      subject: { reference: `Patient/${PATIENT_ID}` },
    })

    // Act
    mountLiftingApp()

    // Assert
    expect(await screen.findByRole('heading', { name: 'Workout A' })).toBeDefined()
    expect(screen.queryByText(/could not be read/)).toBeNull()
    expect(
      server.searches.some(
        (query) =>
          query.startsWith('CarePlan?') &&
          query.includes(`category=${encodeURIComponent(LIFTING_PLAN_CATEGORY_TOKEN)}`)
      )
    ).toBe(true)
  })

  // `src/config.ts` names the resource types the app may search and write,
  // and the gatekeeper client is seeded with exactly that string. A flow that
  // wrote or searched a type the string does not grant would be refused at
  // authorize time; here it surfaces as a type outside the granted set.
  it('should search and write only the resource types its requested scopes grant', async () => {
    // Arrange / Act — save a plan, log a session, apply the progression
    mountLiftingApp()
    await userEvent.click(await screen.findByRole('button', { name: 'Create a plan' }))
    await userEvent.click(screen.getByRole('button', { name: 'Start from StrongLifts 5×5' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save plan' }))
    await screen.findByRole('heading', { name: 'Workout A' })
    await userEvent.click(screen.getByRole('button', { name: 'Log session' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Apply progression' }))
    await screen.findByText('Every load holds — there is nothing to apply.')

    // Assert
    const written = new Set(server.batches.flat().map(resourceTypeOfWire))
    // A later page's query is the server's absolute `next` URL; its type is the last path segment.
    const searched = new Set(
      server.searches.map((query) => (query.split('?')[0] ?? '').split('/').at(-1) ?? '')
    )
    expect([...written].every((type) => grantedTypes('u').has(type))).toBe(true)
    expect([...searched].every((type) => grantedTypes('s').has(type))).toBe(true)
    expect(written.size).toBeGreaterThan(0)
  })

  it('should follow the most recently created of two readable plans, and say the other is there', async () => {
    // Arrange — the older plan first, so server order alone would pick it
    server.seedPlan(strongLifts5x5())
    const newer = { ...strongLifts5x5(), title: 'Newer 5×5' }
    server.seedPlan(newer, { carePlanId: 'plan-2', created: '2026-09-20T09:00:00.000Z' })

    // Act
    mountLiftingApp()
    await userEvent.click(await screen.findByRole('button', { name: 'Plan' }))

    // Assert
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveProperty('value', 'Newer 5×5')
    expect(
      screen.getByText(/1 other active lifting plan on your record is not the one shown here/)
    ).toBeDefined()
  })

  it('should say how many active plans could not be read, and follow the one that could', async () => {
    // Arrange — a readable plan beside a CarePlan whose goal is missing
    server.seedPlan(strongLifts5x5())
    server.seedWire({
      resourceType: 'CarePlan',
      id: 'broken-plan',
      status: 'active',
      intent: 'plan',
      title: 'Half-written',
      category: [liftingCategoryWire],
      subject: { reference: `Patient/${PATIENT_ID}` },
      goal: [{ reference: 'Goal/not-there' }],
    })

    // Act
    mountLiftingApp()

    // Assert
    expect(
      await screen.findByText(
        /1 active plan on your record could not be read as a lifting plan and is not shown/
      )
    ).toBeDefined()
    expect(await screen.findByRole('heading', { name: 'Workout A' })).toBeDefined()
  })

  it('should offer to create a plan when every active plan is unreadable', async () => {
    // Arrange
    server.seedWire({
      resourceType: 'CarePlan',
      id: 'broken-plan',
      status: 'active',
      intent: 'plan',
      category: [liftingCategoryWire],
      subject: { reference: `Patient/${PATIENT_ID}` },
    })

    // Act
    mountLiftingApp()

    // Assert
    expect(await screen.findByText(/1 active plan on your record could not be read/)).toBeDefined()
    expect(screen.getByRole('button', { name: 'Create a plan' })).toBeDefined()
  })

  it('should count unreadable and retracted attempts separately, reading the rest', async () => {
    // Arrange — every page of the search is read (the fake server pages at two)
    const plan = strongLifts5x5()
    server.seedPlan(plan)
    const [firstWorkout] = plan.workouts
    const loggedAttempts = goalsFor(plan, firstWorkout).map((goal): ExerciseAttempt => ({
      exercise: goal.exercise,
      workoutLabel: firstWorkout.label,
      performedAt: DateTime.unsafeMake('2026-09-24T14:30:00.000Z'),
      loadLb: goal.loadLb,
      prescribedSets: goal.sets,
      prescribedReps: goal.reps,
      repsCompleted: Arr.replicate(goal.reps, goal.sets),
    }))
    server.seedAttempts(loggedAttempts)
    const basedOn = [{ reference: `CarePlan/${SEEDED_CARE_PLAN_ID}` }]
    const subject = { reference: `Patient/${PATIENT_ID}` }
    server.seedWire({
      resourceType: 'Observation',
      id: 'retracted',
      status: 'entered-in-error',
      code: { text: 'Squat' },
      subject,
      basedOn,
    })
    server.seedWire({
      resourceType: 'Observation',
      id: 'unreadable',
      status: 'final',
      code: { text: 'Squat' },
      subject,
      basedOn,
    })

    // Act
    mountLiftingApp()

    // Assert — workout A was read in full, so workout B is due
    expect(await screen.findByRole('heading', { name: 'Workout B' })).toBeDefined()
    expect(screen.getByText(/1 logged attempt could not be read/)).toBeDefined()
    expect(screen.getByText(/1 logged attempt was retracted and is not counted/)).toBeDefined()
    expect(server.searches.some((query) => query.includes('_offset='))).toBe(true)
  })
})

// Helpers

/** The minimal slice of a stored resource the fake server's search matching reads. */
const StoredResourceFields = Schema.Struct({
  resourceType: Schema.String,
  id: Schema.String,
  status: Schema.optional(Schema.String),
  subject: Schema.optional(Schema.Struct({ reference: Schema.optional(Schema.String) })),
  basedOn: Schema.optional(
    Schema.Array(Schema.Struct({ reference: Schema.optional(Schema.String) }))
  ),
  category: Schema.optional(
    Schema.Array(
      Schema.Struct({
        coding: Schema.optional(
          Schema.Array(
            Schema.Struct({
              system: Schema.optional(Schema.String),
              code: Schema.optional(Schema.String),
            })
          )
        ),
      })
    )
  ),
})
type StoredResourceFields = typeof StoredResourceFields.Type

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

/** One resource the server holds: its wire JSON, and the fields search matches on. */
interface StoredResource {
  readonly wire: unknown
  readonly fields: StoredResourceFields
}

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
  readonly batches: (readonly unknown[])[]
  readonly transport: Layer.Layer<HttpClient.HttpClient>
  readonly clientFor: (patientId: string | null) => Client
  readonly seedWire: (wire: unknown) => void
  readonly seedPlan: (
    plan: Plan,
    stored?: { readonly carePlanId: string; readonly created: string }
  ) => void
  readonly seedAttempts: (attempts: readonly ExerciseAttempt[]) => void
  /** Refuse every entry of every batch from now on. */
  readonly rejectWrites: () => void
  /** Accept every entry again, after {@link FakeFhirServer.rejectWrites}. */
  readonly acceptWrites: () => void
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

/**
 * An in-memory FHIR server: searches answered from its store (`patient`,
 * `status` and `based-on` honoured, paged at {@link PAGE_SIZE} with a `next`
 * link), batch `Bundle`s applied to it entry by entry.
 */
const fakeFhirServer = (): FakeFhirServer => {
  const store = new Map<string, StoredResource>()
  const searches: string[] = []
  const requests: RecordedRequest[] = []
  const batches: (readonly unknown[])[] = []
  let rejecting = false
  let rejectOnceType: string | null = null
  let held: Promise<void> = Promise.resolve()
  let searchesFail = false

  const seedWire = (wire: unknown): void => {
    const fields = Schema.decodeUnknownSync(StoredResourceFields)(wire)
    store.set(`${fields.resourceType}/${fields.id}`, { wire, fields })
  }

  const matches = (fields: StoredResourceFields, params: URLSearchParams): boolean => {
    const patient = params.get('patient')
    const status = params.get('status')
    const basedOn = params.get('based-on')
    const category = params.get('category')
    const categoryTokens = (fields.category ?? []).flatMap((concept) =>
      (concept.coding ?? []).map((coding) => `${coding.system ?? ''}|${coding.code ?? ''}`)
    )
    return (
      (category === null || categoryTokens.includes(category)) &&
      (patient === null || fields.subject?.reference === `Patient/${patient}`) &&
      (status === null || fields.status === status) &&
      (basedOn === null || (fields.basedOn ?? []).some((ref) => ref.reference === basedOn))
    )
  }

  const searchset = (query: string): unknown => {
    searches.push(query)
    const relative = query.startsWith(`${SERVER_URL}/`) ? query.slice(SERVER_URL.length + 1) : query
    const [resourceType, search = ''] = relative.split('?')
    const params = new URLSearchParams(search)
    const offset = Number(params.get('_offset') ?? '0')
    const found = [...store.values()].filter(
      ({ fields }) => fields.resourceType === resourceType && matches(fields, params)
    )
    params.set('_offset', String(offset + PAGE_SIZE))
    return {
      resourceType: 'Bundle',
      type: 'searchset',
      entry: found.slice(offset, offset + PAGE_SIZE).map(({ wire }) => ({ resource: wire })),
      link:
        offset + PAGE_SIZE < found.length
          ? [{ relation: 'next', url: `${SERVER_URL}/${resourceType}?${params.toString()}` }]
          : [],
    }
  }

  const clientFor = (patientId: string | null): Client => {
    const stub = {
      request: (query: string): Promise<unknown> =>
        searchesFail
          ? Promise.reject(new Error('search refused by test server'))
          : Promise.resolve(searchset(query)),
      patient: { id: patientId },
      state: { serverUrl: SERVER_URL, tokenResponse: { access_token: ACCESS_TOKEN } },
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test-only stub: the app reads `request`, `patient.id` and `state`
    return stub as unknown as Client
  }

  const transport = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      requests.push({ url: request.url, authorization: request.headers['authorization'] })
      const bundle = Schema.decodeUnknownSync(BatchBundle)(decodeBody(request.body))
      batches.push(bundle.entry.map((entry) => entry.resource))
      const responses = bundle.entry.map((entry) => {
        const entryType = entry.request.url.split('/')[0] ?? ''
        const rejectThisOnce = rejectOnceType === entryType
        if (rejectThisOnce) rejectOnceType = null
        if (rejecting || rejectThisOnce) {
          return {
            response: {
              status: '422 Unprocessable Entity',
              outcome: {
                resourceType: 'OperationOutcome',
                issue: [
                  {
                    severity: 'error',
                    code: 'invariant',
                    diagnostics: `${entry.request.url.split('/')[0] ?? ''} rejected by test server`,
                  },
                ],
              },
            },
          }
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
    batches,
    transport,
    clientFor,
    seedWire,
    seedPlan: (plan, stored = { carePlanId: SEEDED_CARE_PLAN_ID, created: SEEDED_CREATED }) => {
      const { carePlan, goals } = planToFhir(plan, {
        carePlanId: stored.carePlanId,
        goalIdFor:
          stored.carePlanId === SEEDED_CARE_PLAN_ID
            ? seededGoalIdFor
            : (exerciseId) => `${stored.carePlanId}-${exerciseId}`,
        subject: `Patient/${PATIENT_ID}`,
        created: DateTime.unsafeMake(stored.created),
      })
      seedWire(Schema.encodeSync(CarePlan.Schema)(carePlan))
      for (const goal of goals) seedWire(Schema.encodeSync(Goal.Schema)(goal))
    },
    seedAttempts: (attempts) => {
      attempts.forEach((attempt, index) => {
        seedWire(
          Schema.encodeSync(Observation.Schema)(
            attemptToFhir(attempt, {
              observationId: `seeded-attempt-${index}`,
              subject: `Patient/${PATIENT_ID}`,
              goalId: seededGoalIdFor(attempt.exercise.id),
              carePlanId: SEEDED_CARE_PLAN_ID,
            })
          )
        )
      })
    },
    rejectWrites: () => {
      rejecting = true
    },
    acceptWrites: () => {
      rejecting = false
    },
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
        .filter(({ fields }) => fields.resourceType === resourceType)
        .map(({ fields }) => fields.id)
        .toSorted(Order.string),
  }
}

const decodeBody = (body: HttpClientRequest.HttpClientRequest['body']): string =>
  body._tag === 'Uint8Array' ? new TextDecoder().decode(body.body) : ''

/** The resources of `resourceType` in one written batch, decoded as the app's readers decode them. */
const decodedOfType = <A, I>(
  batch: readonly unknown[] | undefined,
  resourceType: string,
  schema: Schema.Schema<A, I>
): readonly A[] =>
  Arr.filterMap(batch ?? [], (wire) =>
    Schema.decodeUnknownOption(Schema.Struct({ resourceType: Schema.Literal(resourceType) }))(
      wire
    ).pipe(Option.flatMap(() => Schema.decodeUnknownOption(schema)(wire)))
  )

/** The ids of a written batch's resources, in order. */
const idsOf = (batch: readonly unknown[]): readonly string[] =>
  batch.map((wire) => Schema.decodeUnknownSync(StoredResourceFields)(wire).id)

/** A written resource's `resourceType`. */
const resourceTypeOfWire = (wire: unknown): string =>
  Schema.decodeUnknownSync(StoredResourceFields)(wire).resourceType

/**
 * The resource types `config.ts`'s EHR-launch scope string grants `permission`
 * (a SMART v2 letter: `s` search, `u` update) on, read off the string itself.
 */
const grantedTypes = (permission: string): ReadonlySet<string> =>
  new Set(
    smartConfig.scope.split(' ').flatMap((scope) => {
      const [, resourceType, permissions] = /^system\/(\w+)\.([cruds]+)$/.exec(scope) ?? []
      return resourceType !== undefined && permissions?.includes(permission) ? [resourceType] : []
    })
  )

/** An attempt with its instant as ISO text, so two attempts compare by value. */
const comparableAttempt = (attempt: ExerciseAttempt): unknown => ({
  ...attempt,
  performedAt: DateTime.formatIso(attempt.performedAt),
})

/** A written Observation read back through `attemptFromFhir`, comparable by value. */
const readAttempt = (observation: typeof Observation.Schema.Type): unknown =>
  Either.match(attemptFromFhir(observation), {
    onLeft: () => 'unreadable',
    onRight: Option.match({ onNone: () => 'retracted', onSome: comparableAttempt }),
  })

/** Render `node` over a retry-free `QueryClient`, as `SmartAppRoot` would provide one. */
const renderWithQueryClient = (node: ReactNode, queryClient = testQueryClient()): void => {
  render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>)
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
