import { useQueryClient } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { buildSmartRouterContext, type SmartRuntime } from '@wildflowerhealthio/fhir-r4-react/smart'
import {
  LoadingLine,
  type SmartAppPage,
  SmartHandshakeGate,
} from '@wildflowerhealthio/smart-app-react'
import { type JSX, useState } from 'react'

import { AppTitle } from './app-title.tsx'
import { smartRegistration } from './config.ts'
import { strongLiftsPlanDefinitionIdMinter } from './ids/strong-lifts-plan-definition-id-minter.ts'
import { buildRouter } from './router.ts'
import styles from './app.module.css'

/** Props for {@link App}. */
interface AppProps {
  /** The page the app's router runs over. */
  readonly page: SmartAppPage
}

/** Props for {@link StrengthRouter}. */
type StrengthRouterProps = AppProps & {
  /** The runtime the completed SMART handshake built, which every read and write runs on. */
  readonly runtime: SmartRuntime
}

/**
 * The lifting page's router, built once, on mount, from the URL as it is
 * then.
 *
 * @remarks
 * Mounted under `smart-app-react`'s `SmartHandshakeGate`, so never before the
 * handshake is done with the callback URL.
 *
 * Its context is fixed for the visit: the page's query cache, the one runtime
 * the handshake builds (its code is single-use, so there is never a second),
 * which addresses every read and write to the FHIR base with the bearer
 * token, and the StrongLifts template ids. Whose record the page shows is the path, so a patient change is a
 * navigation and the router lives as long as the page.
 */
function StrengthRouter({ page, runtime }: StrengthRouterProps): JSX.Element {
  const queryClient = useQueryClient()
  const [router] = useState(() =>
    buildRouter(page, {
      ...buildSmartRouterContext(runtime, queryClient),
      strongLiftsPlanDefinitionIdFor: strongLiftsPlanDefinitionIdMinter(),
    })
  )
  return <RouterProvider router={router} />
}

/**
 * The redirect-target app: completes the SMART handshake and then hands the
 * page to its router: the patient picker at `/patients`, one lifter's
 * Today, Plan and Workouts under `/patients/$patientId`, and every patient's
 * workouts at `/workouts`. The callback lands on `/`, which opens the route
 * the launch started on, else its patient's page, else the picker.
 *
 * @remarks
 * The token exchange (`useSmartHandshake`) is a TanStack Query on the page's
 * shared client, keyed and deduped so StrictMode's double-mount exchanges the
 * single-use code once; the routes read the lifter's record on the same
 * client, and read and write through the runtime the handshake builds.
 */
const App = ({ page }: AppProps): JSX.Element => (
  <main className={styles['app']}>
    <SmartHandshakeGate
      registration={smartRegistration}
      servedDirectory={page.basepath}
      connecting={
        <>
          <AppTitle />
          <LoadingLine />
        </>
      }
    >
      {(runtime) => <StrengthRouter page={page} runtime={runtime} />}
    </SmartHandshakeGate>
  </main>
)

export { App, type AppProps, StrengthRouter, type StrengthRouterProps }
