import { FetchHttpClient, type HttpClient } from '@effect/platform'
import { useQueryClient } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { buildSmartRouterContext } from '@wildflowerhealthio/fhir-r4-react/smart'
import {
  launchPatientRoute,
  LoadingLine,
  type SmartAppPage,
  SmartHandshakeGate,
} from '@wildflowerhealthio/smart-app-react'
import type { Layer } from 'effect'
import { type JSX, useState } from 'react'

import { AppTitle } from './app-title.tsx'
import { strongLiftsPlanDefinitionIdMinter } from './ids/strong-lifts-plan-definition-id-minter.ts'
import { buildRouter } from './router.ts'
import type { SmartClient } from './smart-client.ts'
import styles from './app.module.css'

/** Props for {@link App}. */
interface AppProps {
  /** The page the app's router runs over. */
  readonly page: SmartAppPage
}

/** Props for {@link StrengthRouter}. */
type StrengthRouterProps = AppProps & {
  /** The client the completed SMART handshake handed the app. */
  readonly client: SmartClient
  /** What the writes are sent over: `FetchHttpClient.layer`, or a test's stub. */
  readonly transport: Layer.Layer<HttpClient.HttpClient>
}

/**
 * The lifting page's router, built once, on mount, from the URL as it is
 * then.
 *
 * @remarks
 * Mounted under `smart-app-react`'s `SmartHandshakeGate`, so never before the
 * handshake is done with the callback URL.
 *
 * Its context is fixed for the visit: the page's query cache, the one client
 * the handshake hands out (its code is single-use, so there is never a
 * second), the write runner `buildSmartRouterContext` builds over it and
 * `transport` (the one shared function that prefixes the FHIR base and sets
 * the bearer header, on the page's query cache), and the StrongLifts template
 * ids. Whose record the page shows is the path, so a patient change is a
 * navigation and the router lives as long as the page.
 */
function StrengthRouter({ page, client, transport }: StrengthRouterProps): JSX.Element {
  const queryClient = useQueryClient()
  const [router] = useState(() =>
    buildRouter(page, {
      queryClient,
      client,
      runAuthed: buildSmartRouterContext(
        {
          serverUrl: client.state.serverUrl,
          accessToken: client.state.tokenResponse?.access_token,
        },
        transport,
        queryClient
      ).runAuthed,
      strongLiftsPlanDefinitionIdFor: strongLiftsPlanDefinitionIdMinter(),
    })
  )
  return <RouterProvider router={router} />
}

/**
 * The redirect-target app: completes the SMART handshake and then hands the
 * page to its router: the introduction at `/`, the patient picker at
 * `/patients`, one lifter's Today, Plan and Workouts under
 * `/patients/$patientId`, and every patient's workouts at `/workouts`. A
 * completed launch opens the route it started on, else its patient's page,
 * else the picker (`launchPatientRoute`).
 *
 * @remarks
 * The token exchange (`useSmartHandshake`) is a TanStack Query on the page's
 * shared client, keyed and deduped so StrictMode's double-mount exchanges the
 * single-use code once; the routes read the lifter's record on the same
 * client. Reads go through the fhirclient client the handshake yields (its
 * `request` already carries the token and the server base); writes go
 * through `fetch`.
 */
const App = ({ page }: AppProps): JSX.Element => (
  <main className={styles['app']}>
    <SmartHandshakeGate
      page={page}
      landsOn={launchPatientRoute}
      connecting={
        <>
          <AppTitle />
          <LoadingLine />
        </>
      }
    >
      {(client) => <StrengthRouter page={page} client={client} transport={FetchHttpClient.layer} />}
    </SmartHandshakeGate>
  </main>
)

export { App, type AppProps, StrengthRouter, type StrengthRouterProps }
