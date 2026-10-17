import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'

import { STRENGTH_SCOPE } from '../config.ts'
import {
  type FakeFhirServer,
  resourceTypeOfQuery,
  resourceTypeOfWire,
  searchParamsOf,
} from '../fake-fhir-server.test-helpers.ts'
import {
  BASEPATH,
  currentRoute,
  END_TO_END_TIMEOUT_MILLIS,
  endStrengthTest,
  mountStrengthApp,
  PATIENT_ID,
  seedPatient,
  seedStartedLifter,
  seedWorkout,
  startStrengthTest,
  tabLink,
  tapEverySet,
} from '../strength-app.test-helpers.ts'

/**
 * The app's routes, driven through its router over the
 * in-memory FHIR server (see `strength-app.test-helpers.ts`).
 */

let server: FakeFhirServer

beforeEach(() => {
  server = startStrengthTest()
})

afterEach(endStrengthTest)

describe('The strength routes', { timeout: END_TO_END_TIMEOUT_MILLIS }, () => {
  it('should search and write only the resource types its requested scopes grant', async () => {
    // Arrange — a start, a workout and the history: every read and write the app makes
    const user = userEvent.setup()
    mountStrengthApp(server)
    await user.click(await screen.findByRole('button', { name: 'Start program' }))
    await screen.findByRole('heading', { name: 'Workout A' })
    await tapEverySet(user, 'Squat', 5)
    await user.click(screen.getByRole('button', { name: 'Submit workout' }))
    await user.click(await screen.findByRole('button', { name: 'Next workout' }))
    await user.click(tabLink('Workouts'))
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

  it('should open a lifter’s bare path on Today, in its place in history', async () => {
    // Arrange
    seedStartedLifter(server)
    const historyLength = window.history.length

    // Act
    mountStrengthApp(server, { route: `patients/${PATIENT_ID}` })

    // Assert
    await waitFor(() => {
      expect(currentRoute()).toBe(`patients/${PATIENT_ID}/today`)
    })
    expect(window.history.length).toBe(historyLength)
    expect(tabLink('Today').getAttribute('aria-current')).toBe('page')
  })

  it('should link every tab under the lifter the path names', async () => {
    // Act
    mountStrengthApp(server, { route: `patients/${PATIENT_ID}/today` })

    // Assert
    await screen.findByRole('button', { name: 'Start program' })
    expect(tabLink('Plan').getAttribute('href')).toBe(`${BASEPATH}patients/${PATIENT_ID}/plan`)
    expect(tabLink('Workouts').getAttribute('href')).toBe(
      `${BASEPATH}patients/${PATIENT_ID}/workouts`
    )
  })

  it('should read a numeric-looking patient id in the path as the id it is', async () => {
    // Arrange — `1.50` would read as the number 1.5 under a JSON parser
    const user = userEvent.setup()
    seedPatient(server, '1.50')
    mountStrengthApp(server, { route: 'patients/1.50/today' })
    await screen.findByRole('button', { name: 'Start program' })

    // Act
    await user.click(tabLink('Workouts'))

    // Assert — the patient read and every scoped search named `1.50`
    await waitFor(() => {
      expect(currentRoute()).toBe('patients/1.50/workouts')
    })
    expect(server.reads).toContain('Patient/1.50')
    const scopedPatients = new Set(
      server.searches.flatMap((query) => searchParamsOf(query).getAll('patient'))
    )
    expect([...scopedPatients]).toEqual(['1.50'])
  })

  it('should remount the lifter’s page for another lifter on the same tab', async () => {
    // Arrange
    seedPatient(server, 'pat-2')
    const page = mountStrengthApp(server, { route: `patients/${PATIENT_ID}/workouts` })
    await screen.findByText('Ada Lovelace · born 1990-01-01')
    const firstStrip = screen.getByRole('navigation', { name: 'Strength views' })

    // Act — as Forward to another lifter's entry would
    act(() => {
      page.history.push(`${BASEPATH}patients/pat-2/workouts`)
    })

    // Assert — a new page, not the first one re-rendered
    expect(await screen.findByText('Grace Hopper · born 1906-12-09')).toBeDefined()
    expect(screen.getByRole('navigation', { name: 'Strength views' })).not.toBe(firstStrip)
  })

  it.each([
    { case: 'a path no route names', route: 'nowhere', pathname: '/nowhere' },
    {
      case: 'a path under a lifter no tab names',
      route: `patients/${PATIENT_ID}/nowhere`,
      pathname: `/patients/${PATIENT_ID}/nowhere`,
    },
  ])(
    'should show the not-found card for $case, opening the picker from it',
    async ({ route, pathname }) => {
      // Arrange
      const user = userEvent.setup()
      mountStrengthApp(server, { route })
      const title = `Wildflower Strength has no page at ${pathname}.`
      expect(await screen.findByText(title)).toBeDefined()

      // Act
      await user.click(screen.getByRole('button', { name: 'Choose a patient' }))

      // Assert
      expect(await screen.findByRole('heading', { name: 'Choose a patient' })).toBeDefined()
      expect(currentRoute()).toBe('patients')
      expect(screen.queryByText(title)).toBeNull()
    }
  )

  it('should say the server has no patient for an id it does not hold, with no tabs', async () => {
    // Act
    mountStrengthApp(server, { route: 'patients/bogus/today' })

    // Assert — and nothing of theirs is read past the patient
    expect(await screen.findByText('Wildflower Strength has no patient bogus.')).toBeDefined()
    expect(screen.queryByRole('navigation', { name: 'Strength views' })).toBeNull()
    expect(server.searches).toEqual([])
  })

  it('should name the lifter under the title', async () => {
    // Act
    mountStrengthApp(server)

    // Assert
    expect(await screen.findByText('Ada Lovelace · born 1990-01-01')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Change patient' })).toBeDefined()
  })

  it("should show every patient's workouts at /workouts, read unscoped, with no tabs", async () => {
    // Arrange
    seedStartedLifter(server)
    seedWorkout(server, { squat: [5, 5, 5, 5, 5], 'bench-press': [5, 5, 5, 5, 5] })

    // Act
    mountStrengthApp(server, { route: 'workouts' })

    // Assert — the workouts are listed, and no search named a patient
    expect(await screen.findByText(/^Workout A · /)).toBeDefined()
    expect(screen.getByText('All patients')).toBeDefined()
    expect(screen.queryByRole('navigation', { name: 'Strength views' })).toBeNull()
    expect(server.searches).not.toHaveLength(0)
    expect(server.searches.every((query) => !searchParamsOf(query).has('patient'))).toBe(true)
    expect(server.writes).toEqual([])
  })

  it('should introduce the app at /, opening the picker from it', async () => {
    // Arrange
    const user = userEvent.setup()
    mountStrengthApp(server, { route: '' })
    expect(await screen.findByRole('heading', { name: 'Strength', level: 1 })).toBeDefined()

    // Act
    await user.click(screen.getByRole('link', { name: 'Choose a patient' }))

    // Assert
    expect(await screen.findByRole('heading', { name: 'Choose a patient' })).toBeDefined()
    expect(currentRoute()).toBe('patients')
  })
})

/**
 * The resource types `STRENGTH_SCOPE` grants `permission` on (a SMART v2
 * letter: `s` search, `c` create, `u` update), read off the string itself.
 */
const grantedTypes = (permission: string): readonly string[] =>
  STRENGTH_SCOPE.split(' ').flatMap((scope) => {
    const [, resourceType, permissions] = /^system\/(\w+)\.([cruds]+)$/.exec(scope) ?? []
    return resourceType !== undefined && permissions?.includes(permission) ? [resourceType] : []
  })
