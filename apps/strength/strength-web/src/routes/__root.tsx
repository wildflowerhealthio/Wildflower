import { createRootRouteWithContext, retainSearchParams } from '@tanstack/react-router'
import { RouteTabs } from '@wildflowerhealthio/react-tundraish'
import {
  PATIENT_PARAM,
  PatientChoiceLine,
  type PatientChoice,
  PatientPicker,
  PatientSearch,
} from '@wildflowerhealthio/smart-app-react'
import { Match, Option, Schema } from 'effect'
import type { JSX } from 'react'

import { type RouterContext, useStrengthContext } from '../router-context.ts'
import type { SmartClient } from '../smart-client.ts'
import { useStrengthPatientPicker } from './-chosen-patient.ts'
import { StrengthNotFound } from './-strength-not-found.tsx'
import styles from './-strength-page.module.css'

/** Props for {@link StrengthPage}. */
interface StrengthPageProps {
  readonly client: SmartClient
  /** Whose record the page shows. */
  readonly patientChoice: PatientChoice
  /** Open the patient picker: the patient line's "Change patient". */
  readonly onPatientChange: () => void
}

/**
 * The lifting page: whose record it is, over the tabs, each a child route
 * the strip links to: Today, the workout due (or a program's start); Plan,
 * the program editor; History, the completed workouts.
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
function StrengthPage({ client, patientChoice, onPatientChange }: StrengthPageProps): JSX.Element {
  return (
    <>
      <div className={styles['strength-page__status']}>
        <PatientChoiceLine
          client={client}
          patientChoice={patientChoice}
          onPatientChange={onPatientChange}
        />
      </div>
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
 * The root route's page: the lifting page for the patient chosen, or, with
 * none (or on the entry "Change patient" pushes), the patient picker.
 */
function StrengthRoot(): JSX.Element {
  const { client } = useStrengthContext()
  const { patientChoice: shownPatient, choosePatient, changePatient } = useStrengthPatientPicker()
  return Match.value({ patientChoice: Option.getOrUndefined(shownPatient) }).pipe(
    Match.when({ patientChoice: Match.defined }, ({ patientChoice }): JSX.Element => (
      <StrengthPage client={client} patientChoice={patientChoice} onPatientChange={changePatient} />
    )),
    Match.orElse((): JSX.Element => (
      <PatientPicker client={client} onPatientChoice={choosePatient} />
    ))
  )
}

/**
 * The root route: the patient picker or the lifting page, each of whose tabs
 * is a child route, and in the tab panel for a path no tab names, the
 * not-found card.
 *
 * @remarks
 * Every navigation keeps `?patient=` (and only it), so changing tabs keeps
 * the patient and each history entry names the patient it showed; the
 * picker's `?picking-patient=` stays on the one entry that opened it.
 */
const Route = createRootRouteWithContext<RouterContext>()({
  validateSearch: Schema.standardSchemaV1(PatientSearch),
  search: { middlewares: [retainSearchParams([PATIENT_PARAM])] },
  component: StrengthRoot,
  notFoundComponent: StrengthNotFound,
})

export { Route }
