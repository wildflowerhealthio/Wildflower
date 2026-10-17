import { useQueryClient } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import type { SmartClient } from '@wildflowerhealthio/fhir-r4-react/smart'
import {
  LoadingLine,
  type SmartAppPage,
  SmartHandshakeGate,
} from '@wildflowerhealthio/smart-app-react'
import { type JSX, useState } from 'react'

import { makePageStore } from './page-state.ts'
import { buildRouter } from './router.ts'
import styles from './app.module.css'

/** Props for {@link App}. */
interface AppProps {
  /** The page the app's router runs over. */
  readonly page: SmartAppPage
}

/** Props for {@link MedicationsRouter}. */
type MedicationsRouterProps = AppProps & {
  /** The client the completed SMART handshake handed the app. */
  readonly client: SmartClient
}

/**
 * The medications page's router, built once, on mount, from the URL as it is
 * then.
 *
 * @remarks
 * Mounted under `smart-app-react`'s `SmartHandshakeGate`, so never before the
 * handshake is done with the callback URL.
 *
 * Its context is fixed for the visit: the page's query cache, the one client
 * the handshake hands out (its code is single-use, so there is never a second),
 * and a fresh {@link makePageStore}. Whose medications the page reads is the
 * root route's `?patient=`, so a patient change is a navigation and the
 * router lives as long as the page.
 */
function MedicationsRouter({ page, client }: MedicationsRouterProps): JSX.Element {
  const queryClient = useQueryClient()
  const [router] = useState(() =>
    buildRouter(page, { queryClient, client, pageStore: makePageStore() })
  )
  return <RouterProvider router={router} />
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
const App = ({ page }: AppProps): JSX.Element => (
  <main className={styles['app']}>
    <header className={styles['app__header']}>
      <h1 className="text-heading-3">Medications</h1>
    </header>
    <SmartHandshakeGate connecting={<LoadingLine subject="medications" />}>
      {(client) => <MedicationsRouter page={page} client={client} />}
    </SmartHandshakeGate>
  </main>
)

export { App, type AppProps }
