import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  retainSearchParams,
  type RouterHistory,
  RouterProvider,
} from '@tanstack/react-router'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Match, Option, Schema } from 'effect'
import type { JSX } from 'react'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { PATIENT_PARAM, patientChoiceKeyOf } from './patient-choice.ts'
import { parsePlainSearch, stringifyPlainSearch } from './plain-search.ts'
import {
  PatientSearch,
  PICKING_PATIENT_PARAM,
  routedPatientChoiceOf,
  useRoutedPatientChoice,
  useRoutedPatientPicker,
} from './routed-patient-choice.ts'

afterEach(() => {
  cleanup()
})

describe('routedPatientChoiceOf', () => {
  it('should read the address bar’s patient over the launch’s', () => {
    expect(routedPatientChoiceOf('p2', 'p1')).toStrictEqual(
      Option.some({ kind: 'patient', patientId: 'p2' })
    )
  })

  it('should read `*` as every patient', () => {
    expect(routedPatientChoiceOf('*', 'p1')).toStrictEqual(Option.some({ kind: 'all-patients' }))
  })

  it.each([
    { case: 'no `?patient=`', patientKey: undefined },
    { case: 'an empty `?patient=`', patientKey: '' },
  ])('should fall back to the launch’s patient with $case', ({ patientKey }) => {
    expect(routedPatientChoiceOf(patientKey, 'p1')).toStrictEqual(
      Option.some({ kind: 'patient', patientId: 'p1' })
    )
  })

  it('should be no choice yet with neither', () => {
    expect(routedPatientChoiceOf(undefined, null)).toStrictEqual(Option.none())
  })
})

/** A child route's page, naming the choice the hook reads there. */
function ChoiceLine(): JSX.Element {
  const patientChoice = useRoutedPatientChoice('p1')
  return <p>{Option.getOrElse(Option.map(patientChoice, patientChoiceKeyOf), () => 'none')}</p>
}

/** Render a router whose root validates {@link PatientSearch}, at `url`, with a child route at `/tab`. */
const renderAt = (url: string): void => {
  const rootRoute = createRootRoute({ validateSearch: Schema.standardSchemaV1(PatientSearch) })
  const tabRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/tab',
    component: ChoiceLine,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([tabRoute]),
    history: createMemoryHistory({ initialEntries: [url] }),
    parseSearch: parsePlainSearch,
    stringifySearch: stringifyPlainSearch,
  })
  render(<RouterProvider router={router} />)
}

describe('useRoutedPatientChoice', () => {
  it('should read a child route’s `?patient=` as the address bar holds it', async () => {
    renderAt('/tab?patient=1.50')

    expect(await screen.findByText('1.50')).toBeDefined()
  })

  it('should fall back to the launch’s patient without one', async () => {
    renderAt('/tab')

    expect(await screen.findByText('p1')).toBeDefined()
  })
})

/**
 * Render a router whose root shows a link to `/other` over
 * {@link useRoutedPatientPicker}'s page (the patient and "Change patient") or
 * its picker (a "Choose Ada" button), at `url`, choices landing on
 * `choiceLandsOn`; its history, to read the location and go Back.
 */
const renderPickerAt = (url: string, choiceLandsOn: string): RouterHistory => {
  function PickerRoot(): JSX.Element {
    const { patientChoice, choosePatient, changePatient } = useRoutedPatientPicker(
      null,
      choiceLandsOn
    )
    return (
      <>
        <Link to="/other">Other</Link>
        {Match.value({ shown: Option.getOrUndefined(patientChoice) }).pipe(
          Match.when({ shown: Match.defined }, ({ shown }) => (
            <>
              <p>Showing {patientChoiceKeyOf(shown)}</p>
              <button type="button" onClick={changePatient}>
                Change patient
              </button>
              <Outlet />
            </>
          )),
          Match.orElse(() => (
            <button
              type="button"
              onClick={() => {
                choosePatient({ kind: 'patient', patientId: 'ada' })
              }}
            >
              Choose Ada
            </button>
          ))
        )}
      </>
    )
  }
  const rootRoute = createRootRoute({
    validateSearch: Schema.standardSchemaV1(PatientSearch),
    search: { middlewares: [retainSearchParams([PATIENT_PARAM])] },
    component: PickerRoot,
  })
  const childRoutes = ['/', '/tab', '/other'].map((path) =>
    createRoute({ getParentRoute: () => rootRoute, path })
  )
  const history = createMemoryHistory({ initialEntries: [url] })
  const router = createRouter({
    routeTree: rootRoute.addChildren(childRoutes),
    history,
    parseSearch: parsePlainSearch,
    stringifySearch: stringifyPlainSearch,
  })
  render(<RouterProvider router={router} />)
  return history
}

/** Where `history` stands: its path and query. */
const locationOf = (history: RouterHistory): string =>
  `${history.location.pathname}${history.location.search}`

describe('useRoutedPatientPicker', () => {
  it('should show the picker with no patient to show', async () => {
    renderPickerAt('/tab', '.')

    expect(await screen.findByRole('button', { name: 'Choose Ada' })).toBeDefined()
  })

  it('should open the picker over the patient shown, closing it on Back', async () => {
    // Arrange
    const user = userEvent.setup()
    const history = renderPickerAt('/tab?patient=p2', '.')
    await user.click(await screen.findByRole('button', { name: 'Change patient' }))
    await screen.findByRole('button', { name: 'Choose Ada' })
    expect(locationOf(history)).toBe(`/tab?patient=p2&${PICKING_PATIENT_PARAM}=1`)

    // Act
    act(() => {
      history.back()
    })

    // Assert
    expect(await screen.findByText('Showing p2')).toBeDefined()
    expect(locationOf(history)).toBe('/tab?patient=p2')
  })

  it.each([
    { choiceLandsOn: '.', landing: '/tab?patient=ada' },
    { choiceLandsOn: '/', landing: '/?patient=ada' },
  ])(
    'should land a choice on $choiceLandsOn, pushed with ?patient= and no flag',
    async ({ choiceLandsOn, landing }) => {
      // Arrange
      const user = userEvent.setup()
      const history = renderPickerAt('/tab?patient=p2', choiceLandsOn)
      await user.click(await screen.findByRole('button', { name: 'Change patient' }))

      // Act
      await user.click(await screen.findByRole('button', { name: 'Choose Ada' }))

      // Assert — the picker's entry is still Back's
      expect(await screen.findByText('Showing ada')).toBeDefined()
      expect(locationOf(history)).toBe(landing)
      act(() => {
        history.back()
      })
      await screen.findByRole('button', { name: 'Choose Ada' })
    }
  )

  it('should keep ?patient= but not the flag on a link from the picker’s entry', async () => {
    // Act
    renderPickerAt(`/tab?patient=p2&${PICKING_PATIENT_PARAM}=1`, '.')

    // Assert
    await screen.findByRole('button', { name: 'Choose Ada' })
    expect(screen.getByRole('link', { name: 'Other' }).getAttribute('href')).toBe(
      '/other?patient=p2'
    )
  })
})
