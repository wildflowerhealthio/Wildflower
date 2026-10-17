import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { cleanup, render, screen } from '@testing-library/react'
import { Option, Schema } from 'effect'
import type { JSX } from 'react'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { patientChoiceKeyOf } from './patient-choice.ts'
import { parsePlainSearch, stringifyPlainSearch } from './plain-search.ts'
import {
  PatientSearch,
  routedPatientChoiceOf,
  useRoutedPatientChoice,
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
