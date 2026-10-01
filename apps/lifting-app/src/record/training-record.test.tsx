import { screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'

import {
  type FakeFhirServer,
  resourceTypeOfQuery,
  type SearchEvent,
  searchParamsOf,
} from '../fake-fhir-server.test-helpers.ts'
import {
  END_TO_END_TIMEOUT_MILLIS,
  endLiftingTest,
  liftingCategoryWire,
  mountLiftingApp,
  seededExerciseRequests,
  seedStartedLifter,
  seedWorkout,
  startLiftingTest,
  SUBJECT,
} from '../lifting-app.test-helpers.ts'
import { SEARCH_CONCURRENCY } from './read-every-page.ts'

/** Whether a search event is of the active `ServiceRequest` read, the record's first. */
const isActiveRequestSearch = ({ query }: SearchEvent): boolean =>
  resourceTypeOfQuery(query) === 'ServiceRequest' &&
  searchParamsOf(query).get('status') === 'active'

/**
 * Reading the training record and saying what it could not read, driven through
 * `LiftingApp` over the in-memory FHIR server (see
 * `lifting-app.test-helpers.ts`).
 */

let server: FakeFhirServer

beforeEach(() => {
  server = startLiftingTest()
})

afterEach(endLiftingTest)

describe('readTrainingRecord', { timeout: END_TO_END_TIMEOUT_MILLIS }, () => {
  it('should read the sets with one search per active request, however many workouts there are', async () => {
    // Arrange — three workouts on the record
    seedStartedLifter(server)
    seedWorkout(server, { squat: [5, 5, 5, 5, 5] })
    seedWorkout(server, { squat: [5, 5, 5, 5, 5] })
    seedWorkout(server, { squat: [5, 5, 5, 5, 5] })

    // Act
    mountLiftingApp(server)
    await screen.findByRole('heading', { name: 'Workout B' })

    // Assert — the five lifts' requests, and no workout's
    const observationSearches = server.searches
      .filter((query) => resourceTypeOfQuery(query) === 'Observation')
      .map(searchParamsOf)
      .filter((params) => params.has('based-on') || params.has('part-of'))
    expect(observationSearches.every((params) => !params.has('part-of'))).toBe(true)
    expect(new Set(observationSearches.map((params) => params.get('based-on'))).size).toBe(5)
  })

  it('should read the active requests alone, page by page, before any other search starts', async () => {
    // Arrange — five active requests: three pages
    seedStartedLifter(server)

    // Act
    mountLiftingApp(server)
    await screen.findByRole('heading', { name: 'Workout A' })

    // Assert — each page of the first read answered before the next search starts
    const lastFirstReadEnd = server.searchEvents.findLastIndex(isActiveRequestSearch)
    const firstRead = server.searchEvents.slice(0, lastFirstReadEnd + 1)
    expect(firstRead.length).toBeGreaterThan(2)
    expect(firstRead.every(isActiveRequestSearch)).toBe(true)
    expect(firstRead.map(({ kind }) => kind)).toEqual(
      firstRead.map((_, index) => (index % 2 === 0 ? 'start' : 'end'))
    )
    expect(server.searchEvents.length).toBeGreaterThan(firstRead.length)
  })

  it('should hold no more than SEARCH_CONCURRENCY searches in flight, however wide the read fans out', async () => {
    // Arrange — after the first read: the plan, the workouts and five lifts' sets
    seedStartedLifter(server)
    seedWorkout(server, { squat: [5, 5, 5, 5, 5] })
    seedWorkout(server, { squat: [5, 5, 5, 5, 5] })
    seedWorkout(server, { squat: [5, 5, 5, 5, 5] })

    // Act
    mountLiftingApp(server)
    await screen.findByRole('heading', { name: 'Workout B' })

    // Assert — more searches than the cap, never more than the cap at once
    const fanOutSearches = server.searches.filter(
      (query) => resourceTypeOfQuery(query) !== 'ServiceRequest'
    )
    expect(fanOutSearches.length).toBeGreaterThan(SEARCH_CONCURRENCY)
    expect(server.mostSearchesInFlight()).toBe(SEARCH_CONCURRENCY)
  })

  it('should show a failed read as such, not as an empty record', async () => {
    // Arrange
    server.failSearches()

    // Act
    mountLiftingApp(server)

    // Assert — the first read failed, and nothing else was searched
    expect(await screen.findByText(/^Could not load your training: /)).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Start program' })).toBeNull()
    expect(server.searches).toHaveLength(1)
  })
})

describe('TrainingRecordNotices', { timeout: END_TO_END_TIMEOUT_MILLIS }, () => {
  it('should count what it could not read, leaving a retracted set out without counting it', async () => {
    // Arrange — a lifting request that is no exercise request, a malformed set
    // and a retracted one
    seedStartedLifter(server)
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
    mountLiftingApp(server)

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
    mountLiftingApp(server)

    // Assert
    expect(
      await screen.findByText(
        /Your exercise requests follow a program \(.+\) that could not be found/
      )
    ).toBeDefined()
    expect(screen.getByRole('button', { name: 'Start program' })).toBeDefined()
  })
})
