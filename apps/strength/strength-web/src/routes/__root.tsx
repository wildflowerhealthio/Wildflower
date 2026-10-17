import { createRootRouteWithContext, retainSearchParams, useNavigate } from '@tanstack/react-router'
import { useSubscribable } from '@wildflowerhealthio/react-kitchen-sink'
import { RouteTabs } from '@wildflowerhealthio/react-tundraish'
import {
  PATIENT_PARAM,
  PatientChoiceLine,
  type PatientChoice,
  patientChoiceKeyOf,
  PatientPicker,
  PatientSearch,
} from '@wildflowerhealthio/smart-app-react'
import { Match, Option, Schema } from 'effect'
import { type JSX, useEffect } from 'react'

import { type RouterContext, useStrengthContext } from '../router-context.ts'
import type { SmartClient } from '../smart-client.ts'
import { useChangePatient, useChosenPatient } from './-chosen-patient.ts'
import { StrengthNotFound } from './-strength-not-found.tsx'
import styles from './-strength-page.module.css'

/** Props for {@link StrengthPage}. */
interface StrengthPageProps {
  readonly client: SmartClient
  /** Whose record the page shows. */
  readonly patientChoice: PatientChoice
  /** Go back to the patient picker: the patient line's "Change patient". */
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

/** What the root shows: the page for a patient, or the picker. */
interface StrengthRootModel {
  readonly client: SmartClient
  /** Whose record the page shows; `None` while the picker is up. */
  readonly shownPatient: Option.Option<PatientChoice>
  /** Settle on `patientChoice`: the picker's `onPatientChoice`. */
  readonly choosePatient: (patientChoice: PatientChoice) => void
  /** Open the picker over the patient shown: the patient line's "Change patient". */
  readonly changePatient: () => void
}

/**
 * The root's logic: whose record the address bar names, the picker the
 * reader opened over it, and choosing.
 *
 * @remarks
 * A choice navigates to `/`, pushing a history entry on the tab open, with
 * `?patient=` naming it, and `/` opens the choice's first tab in its place:
 * Back returns to the patient before (from the first choice, to the
 * picker), and a reload or a shared link opens the patient the address bar
 * names. "Change patient" only opens the picker, over the patient it was
 * opened from; the address bar keeps that patient until another is chosen,
 * and Back or Forward to an entry naming a different patient closes the
 * picker on that patient's page.
 */
const useStrengthRoot = (): StrengthRootModel => {
  const { client, patientChangingFrom } = useStrengthContext()
  const chosenPatient = useChosenPatient()
  const changePatient = useChangePatient()
  const navigate = useNavigate()
  const chosenKey = Option.getOrNull(Option.map(chosenPatient, patientChoiceKeyOf))
  const changingFrom = useSubscribable(patientChangingFrom.subscribable)
  useEffect(() => {
    // The address bar has moved to another patient (Back, Forward): the
    // picker closes for good, rather than reopening on a return to its entry.
    if (changingFrom !== null && changingFrom !== chosenKey) patientChangingFrom.set(null)
  }, [changingFrom, chosenKey, patientChangingFrom])
  return {
    client,
    shownPatient: Option.filter(chosenPatient, () => changingFrom !== chosenKey),
    choosePatient: (patientChoice) => {
      patientChangingFrom.set(null)
      void navigate({ to: '/', search: { [PATIENT_PARAM]: patientChoiceKeyOf(patientChoice) } })
    },
    changePatient,
  }
}

/**
 * The root route's page: the lifting page for the patient chosen, or, with
 * none (or while the reader changes it), the patient picker.
 */
function StrengthRoot(): JSX.Element {
  const { client, shownPatient, choosePatient, changePatient } = useStrengthRoot()
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
 * the patient and each history entry names the patient it showed.
 */
const Route = createRootRouteWithContext<RouterContext>()({
  validateSearch: Schema.standardSchemaV1(PatientSearch),
  search: { middlewares: [retainSearchParams([PATIENT_PARAM])] },
  component: StrengthRoot,
  notFoundComponent: StrengthNotFound,
})

export { Route }
