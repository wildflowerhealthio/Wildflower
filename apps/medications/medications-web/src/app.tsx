import { useQueryClient } from '@tanstack/react-query'
import { RouterProvider, type RouterHistory } from '@tanstack/react-router'
import {
  useLaunchFailureRedirect,
  useSmartHandshake,
} from '@wildflowerhealthio/fhir-r4-react/smart'
import { ErrorBanner } from '@wildflowerhealthio/react-tundraish'
import { LoadingLine } from '@wildflowerhealthio/smart-app-react'
import { Match } from 'effect'
import { type JSX, useState } from 'react'

import { makePageStore } from './page-state.ts'
import type { SmartClient } from './router-context.ts'
import { buildRouter } from './router.ts'
import styles from './app.module.css'

/** Props for {@link MedicationsRouter}. */
interface MedicationsRouterProps {
  /** The window's history, which the router navigates. */
  readonly history: RouterHistory
  /** The served directory, the router's basepath. */
  readonly basepath: string
  /** The client the completed SMART handshake handed the app. */
  readonly client: SmartClient
}

/**
 * The medications page's router, built once, on mount, from the URL as it is
 * then.
 *
 * @remarks
 * Mounted only once the SMART handshake has completed, by when fhirclient has
 * taken `code` and `state` out of the address bar: the router reads the URL
 * and redirects `/` to a tab, so building it any earlier could rewrite the
 * callback URL the token exchange still reads.
 *
 * Its context is fixed for the visit: the page's query cache, the one client
 * the handshake hands out (its code is single-use, so there is never a second),
 * and a fresh {@link makePageStore}. Whose medications the page reads is the
 * root route's `?patient=`, so a patient change is a navigation and the
 * router lives as long as the page.
 */
function MedicationsRouter({ history, basepath, client }: MedicationsRouterProps): JSX.Element {
  const queryClient = useQueryClient()
  const [router] = useState(() =>
    buildRouter({
      history,
      basepath,
      context: { queryClient, client, pageStore: makePageStore() },
    })
  )
  return <RouterProvider router={router} />
}

/** Props for {@link App}. */
interface AppProps {
  /** The window's history, which the router navigates once the handshake completes. */
  readonly history: RouterHistory
  /** The served directory, the router's basepath. */
  readonly basepath: string
}

/**
 * The redirect-target app: completes the SMART handshake and then hands the
 * page to its router, whose root settles on whose medications to read and
 * whose tabs show them: the medications list, the prescription calendar, the
 * interactions report, and the savings-program breakdown.
 *
 * @remarks
 * The token exchange (`useSmartHandshake`) is a TanStack Query on the page's
 * shared client, keyed and deduped so StrictMode's double-mount exchanges the
 * single-use code once; the routes read the MedicationRequests on the same
 * client.
 */
const App = ({ history, basepath }: AppProps): JSX.Element => {
  const handshake = useSmartHandshake()
  // A failed exchange has nothing to retry here (the code is single-use), so
  // carry the reason to the app root, which can offer the connect menu.
  useLaunchFailureRedirect(handshake)

  const body = Match.value(handshake).pipe(
    Match.when({ kind: 'error' }, ({ error }): JSX.Element => <ErrorBanner error={error} />),
    Match.when({ kind: 'ready' }, ({ client }): JSX.Element => (
      <MedicationsRouter history={history} basepath={basepath} client={client} />
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
