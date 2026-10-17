import { createRootRouteWithContext, retainSearchParams } from '@tanstack/react-router'
import { RouteTabs } from '@wildflowerhealthio/react-tundraish'
import { PatientChoiceLine } from '@wildflowerhealthio/smart-app-react'
import type { JSX } from 'react'

import {
  type RouterContext,
  useChangePatient,
  useChosenPatient,
  useSmartClient,
} from '../router-context.ts'
import styles from './-strength-page.module.css'

/**
 * The lifting page: its title, with whose record it is named under it, over
 * the tabs, each a child route the strip links to: Today, the workout due
 * (or a program's start); Plan, the program editor; History, the completed
 * workouts.
 *
 * @remarks
 * The app holds no lifting logic: reads go through `fhir-r4-react/smart`'s
 * page readers into `strength-core-js`'s schemas (`readTrainingRecord`), each
 * screen is a `strength-react` view over plain props, and each write is what
 * `strength-core-js` returns, in one batch. While any write is pending every
 * screen's controls are disabled, so two writes never race.
 *
 * Every write names one lifter, so only a chosen patient has a
 * `StrengthSession` (in `LifterTab`). With "All patients" the page opens on
 * History, every patient's workouts read unscoped; Today and Plan, which
 * write, ask for a patient instead.
 */
function StrengthPage(): JSX.Element {
  const client = useSmartClient()
  const patientChoice = useChosenPatient()
  const changePatient = useChangePatient()
  return (
    <>
      <header className={styles['strength-page__header']}>
        <h1 className="text-heading-3">Strength</h1>
        <PatientChoiceLine
          client={client}
          patientChoice={patientChoice}
          onPatientChange={changePatient}
        />
      </header>
      <RouteTabs
        tabs={[
          { to: '/today', label: 'Today' },
          { to: '/plan', label: 'Plan' },
          { to: '/history', label: 'History' },
        ]}
        aria-label="Strength views"
      />
    </>
  )
}

/**
 * The root route: the lifting page, each of whose tabs is a child route.
 *
 * @remarks
 * Every navigation keeps the page's query: `?patient=`, which
 * `usePatientChoice` writes when the reader picks a patient, stays in the
 * address bar as the reader changes tabs.
 */
const Route = createRootRouteWithContext<RouterContext>()({
  search: { middlewares: [retainSearchParams(true)] },
  component: StrengthPage,
})

export { Route }
