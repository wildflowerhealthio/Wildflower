import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'

import { LIFTING_SCOPE } from '../config.ts'
import {
  type FakeFhirServer,
  resourceTypeOfQuery,
  resourceTypeOfWire,
} from '../fake-fhir-server.test-helpers.ts'
import {
  END_TO_END_TIMEOUT_MILLIS,
  endLiftingTest,
  mountLiftingApp,
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
