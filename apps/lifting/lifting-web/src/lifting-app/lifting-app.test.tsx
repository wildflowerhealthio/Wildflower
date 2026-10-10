import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'

import { LIFTING_SCOPE } from '../config.ts'
import {
  type FakeFhirServer,
  resourceTypeOfQuery,
  resourceTypeOfWire,
  searchParamsOf,
} from '../fake-fhir-server.test-helpers.ts'
import {
  END_TO_END_TIMEOUT_MILLIS,
  endLiftingTest,
  mountLiftingApp,
  seedStartedLifter,
  seedWorkout,
  startLiftingTest,
  tapEverySet,
} from '../lifting-app.test-helpers.ts'

/**
 * The whole app, every tab, driven through `LiftingApp` over the in-memory FHIR
 * server (see `lifting-app.test-helpers.ts`).
 */

let server: FakeFhirServer

beforeEach(() => {
  server = startLiftingTest()
})

afterEach(endLiftingTest)

describe('LiftingApp', { timeout: END_TO_END_TIMEOUT_MILLIS }, () => {
  it('should search and write only the resource types its requested scopes grant', async () => {
    // Arrange — a start, a workout and the history: every read and write the app makes
    const user = userEvent.setup()
    mountLiftingApp(server)
    await user.click(await screen.findByRole('button', { name: 'Start program' }))
    await screen.findByRole('heading', { name: 'Workout A' })
    await tapEverySet(user, 'Squat', 5)
    await user.click(screen.getByRole('button', { name: 'Submit workout' }))
    await user.click(await screen.findByRole('button', { name: 'Next workout' }))
    await user.click(screen.getByRole('button', { name: 'History' }))
    await screen.findByText(/^Workout A · /)

    // Assert
    const searchedTypes = new Set(server.searches.map(resourceTypeOfQuery))
    const readTypes = new Set(server.reads.map((reference) => reference.split('/')[0] ?? ''))
    const writtenTypes = new Set(server.writes.flat().map(resourceTypeOfWire))
    expect([...searchedTypes].toSorted()).toEqual(
      ['Observation', 'PlanDefinition', 'Procedure', 'ServiceRequest'].toSorted()
    )
    expect([...readTypes]).toEqual(['Patient'])
    for (const resourceType of searchedTypes) expect(grantedTypes('s')).toContain(resourceType)
    for (const resourceType of readTypes) expect(grantedTypes('r')).toContain(resourceType)
    for (const resourceType of writtenTypes) {
      expect(grantedTypes('c')).toContain(resourceType)
      expect(grantedTypes('u')).toContain(resourceType)
    }
  })

  it('should name the lifter under the title', async () => {
    // Act
    mountLiftingApp(server)

    // Assert
    expect(await screen.findByText('Ada Lovelace · born 1990-01-01')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Change patient' })).toBeDefined()
  })

  it("should open All patients on every patient's history, read unscoped, writing nothing", async () => {
    // Arrange
    seedStartedLifter(server)
    seedWorkout(server, { squat: [5, 5, 5, 5, 5], 'bench-press': [5, 5, 5, 5, 5] })

    // Act
    mountLiftingApp(server, { kind: 'all-patients' })

    // Assert — the history is listed, and no search named a patient
    expect(await screen.findByText(/^Workout A · /)).toBeDefined()
    expect(screen.getByText('All patients')).toBeDefined()
    expect(server.searches).not.toHaveLength(0)
    expect(server.searches.every((query) => !searchParamsOf(query).has('patient'))).toBe(true)
    expect(server.writes).toEqual([])
  })

  it.each(['Today', 'Plan'])(
    'should ask for a patient on %s with All patients, offering no control that writes',
    async (tabLabel) => {
      // Arrange
      const user = userEvent.setup()
      seedStartedLifter(server)
      mountLiftingApp(server, { kind: 'all-patients' })

      // Act
      await user.click(screen.getByRole('button', { name: tabLabel }))

      // Assert
      expect(screen.getByText('Choose a patient to train')).toBeDefined()
      expect(screen.getByRole('button', { name: 'Choose a patient' })).toBeDefined()
      expect(screen.queryByRole('button', { name: 'Start program' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Submit workout' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
      expect(server.writes).toEqual([])
    }
  )
})

/**
 * The resource types `LIFTING_SCOPE` grants `permission` on (a SMART v2
 * letter: `s` search, `c` create, `u` update), read off the string itself.
 */
const grantedTypes = (permission: string): readonly string[] =>
  LIFTING_SCOPE.split(' ').flatMap((scope) => {
    const [, resourceType, permissions] = /^system\/(\w+)\.([cruds]+)$/.exec(scope) ?? []
    return resourceType !== undefined && permissions?.includes(permission) ? [resourceType] : []
  })
