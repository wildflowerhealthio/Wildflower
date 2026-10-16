import { useQueryClient } from '@tanstack/react-query'
import { createBrowserHistory, RouterProvider } from '@tanstack/react-router'
import {
  useLaunchFailureRedirect,
  useSmartHandshake,
} from '@wildflowerhealthio/fhir-r4-react/smart'
import { ErrorBanner } from '@wildflowerhealthio/react-tundraish'
import {
  LoadingLine,
  patientChoiceKeyOf,
  PatientPicker,
  usePatientChoice,
} from '@wildflowerhealthio/smart-app-react'
import { Match, Option } from 'effect'
import { type JSX, useState } from 'react'

import { makePageStore } from './page-state.ts'
import type { RouterContext } from './router-context.ts'
import { buildRouter } from './router.ts'
import styles from './app.module.css'

/** Props for {@link MedicationsRouter}. */
interface MedicationsRouterProps {
  /** The served directory, the router's basepath. */
  readonly basepath: string
  /** What every route reads: the handshake's client and the patient chosen. */
  readonly context: RouterContext
}

/**
 * The medications page's router, over the browser's history, built once on
 * mount from the URL as it is then.
 *
 * @remarks
 * Mounted only once the SMART handshake has completed, by when fhirclient has
 * taken `code` and `state` out of the address bar: the router reads the URL
 * and redirects `/` to a tab, so building it any earlier could rewrite the
 * callback URL the token exchange still reads.
 */
function MedicationsRouter({ basepath, context }: MedicationsRouterProps): JSX.Element {
  const [router] = useState(() =>
    buildRouter({ history: createBrowserHistory(), basepath, context })
  )
  return <RouterProvider router={router} />
}

/** Props for {@link App}. */
interface AppProps {
  /** The served directory, the router's basepath. */
  readonly basepath: string
}

/**
 * The redirect-target app: completes the SMART handshake, settles on whose
 * medications to read, and then hands the page to its router, whose tabs show
 * them: the medications list, the prescription calendar, the interactions
 * report, and the savings-program breakdown.
 *
 * @remarks
 * Whose medications is `smart-app-react`'s `usePatientChoice`: the URL's
 * `?patient=`, else the launch's patient (`client.patient.id`); with neither
 * the body is the `PatientPicker`. One patient's requests are read with
 * `patient=`, "All patients" reads every patient's unscoped. The patient line
 * on the page names the choice and goes back to the picker.
 *
 * The token exchange (`useSmartHandshake`) is a TanStack Query on the page's
 * shared client, keyed and deduped so StrictMode's double-mount exchanges the
 * single-use code once; the routes read the MedicationRequests on the same
 * client. Each patient choice gets its own router, keyed on the choice, so a
 * route's context always names the patient the page reads; a new router
 * opens on the tab in the address bar, so changing the patient keeps the tab.
 * The reader's choices on the page ({@link makePageStore}) are kept for the
 * visit, across patient changes too.
 */
const App = ({ basepath }: AppProps): JSX.Element => {
  const queryClient = useQueryClient()
  const handshake = useSmartHandshake()
  // A failed exchange has nothing to retry here (the code is single-use), so
  // carry the reason to the app root, which can offer the connect menu.
  useLaunchFailureRedirect(handshake)
  const client = handshake.kind === 'ready' ? handshake.client : undefined
  const { patientChoice, choosePatient, changePatient } = usePatientChoice(
    client?.patient.id ?? null
  )
  const [pageStore] = useState(makePageStore)

  // Earlier arms win, so the order is priority order: a failed exchange, the
  // exchange still running, the picker with no patient chosen, then the page.
  const body = Match.value({
    handshakeError: handshake.kind === 'error' ? handshake.error : undefined,
    client,
    chosenPatient: Option.getOrUndefined(patientChoice),
  }).pipe(
    Match.when({ handshakeError: Match.defined }, ({ handshakeError }): JSX.Element => (
      <ErrorBanner error={handshakeError} />
    )),
    Match.when({ client: Match.defined, chosenPatient: Match.defined }, (ready): JSX.Element => (
      <MedicationsRouter
        key={patientChoiceKeyOf(ready.chosenPatient)}
        basepath={basepath}
        context={{
          queryClient,
          client: ready.client,
          patientChoice: ready.chosenPatient,
          changePatient,
          pageStore,
        }}
      />
    )),
    Match.when({ client: Match.defined }, (choosing): JSX.Element => (
      <PatientPicker client={choosing.client} onPatientChoice={choosePatient} />
    )),
    Match.orElse((): JSX.Element => <LoadingLine subject="medications" />)
  )

  return (
    <main className={styles['app']}>
      <header className={styles['app__header']}>
        <h1 className="text-heading-3">Medications</h1>
      </header>
      {body}
    </main>
  )
}

export { App, type AppProps }
