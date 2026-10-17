import { FetchHttpClient } from '@effect/platform'
import { useQueryClient } from '@tanstack/react-query'
import { createBrowserHistory, RouterProvider } from '@tanstack/react-router'
import {
  buildSmartRouterContext,
  useLaunchFailureRedirect,
  useSmartHandshake,
} from '@wildflowerhealthio/fhir-r4-react/smart'
import { ErrorBanner } from '@wildflowerhealthio/react-tundraish'
import {
  LoadingLine,
  PatientPicker,
  patientChoiceKeyOf,
  usePatientChoice,
} from '@wildflowerhealthio/smart-app-react'
import { Match, Option } from 'effect'
import { type JSX, useMemo, useState } from 'react'

import { mintResourceId } from './ids/mint-resource-id.ts'
import type { RouterContext } from './router-context.ts'
import { buildRouter } from './router.ts'
import type { SmartClient } from './smart-client.ts'
import styles from './app.module.css'

/** Props for {@link StrengthRouter}. */
interface StrengthRouterProps {
  /** The served directory, the router's basepath. */
  readonly basepath: string
  /** What every route reads, but the template id, which the router mints. */
  readonly context: Omit<RouterContext, 'strongLiftsPlanDefinitionId'>
}

/**
 * The lifting page's router, over the browser's history, built once on mount
 * from the URL as it is then, with a StrongLifts 5×5 template id minted for
 * it.
 *
 * @remarks
 * Mounted only once the SMART handshake has completed, by when fhirclient has
 * taken `code` and `state` out of the address bar: the router reads the URL
 * and redirects `/` to a tab, so building it any earlier could rewrite the
 * callback URL the token exchange still reads.
 */
function StrengthRouter({ basepath, context }: StrengthRouterProps): JSX.Element {
  const [router] = useState(() =>
    buildRouter({
      history: createBrowserHistory(),
      basepath,
      context: { ...context, strongLiftsPlanDefinitionId: mintResourceId() },
    })
  )
  return <RouterProvider router={router} />
}

/**
 * The lifting screens over a completed handshake: the patient picker until a
 * patient is chosen, then the page's router for the choice, rebuilt per
 * choice, opening on the tab in the address bar.
 *
 * @remarks
 * Whose record is `smart-app-react`'s `usePatientChoice`: the URL's
 * `?patient=`, else the launch's patient (`client.patient.id`), else the
 * picker. Writes go through `runAuthed`, the typed client that
 * `buildSmartRouterContext` builds over `FetchHttpClient.layer` — the one
 * shared function that prefixes the FHIR base and sets the bearer header.
 */
const LaunchedStrength = ({
  client,
  basepath,
}: {
  readonly client: SmartClient
  readonly basepath: string
}): JSX.Element => {
  const queryClient = useQueryClient()
  // Memoised on the (stable) resolved client, so a re-render does not rebuild
  // the runtime underneath an in-flight write.
  const runAuthed = useMemo(
    () =>
      buildSmartRouterContext(
        {
          serverUrl: client.state.serverUrl,
          accessToken: client.state.tokenResponse?.access_token,
        },
        FetchHttpClient.layer,
        queryClient
      ).runAuthed,
    [client, queryClient]
  )
  const { patientChoice, choosePatient, changePatient } = usePatientChoice(client.patient.id)

  return Option.match(patientChoice, {
    onNone: () => <PatientPicker client={client} onPatientChoice={choosePatient} />,
    onSome: (chosenPatient) => (
      <StrengthRouter
        key={patientChoiceKeyOf(chosenPatient)}
        basepath={basepath}
        context={{ client, runAuthed, patientChoice: chosenPatient, changePatient }}
      />
    ),
  })
}

/** Props for {@link App}. */
interface AppProps {
  /** The served directory, the router's basepath. */
  readonly basepath: string
}

/**
 * The redirect-target app: completes the SMART handshake, then mounts the
 * lifting screens over it.
 *
 * @remarks
 * Reads go through the fhirclient client the handshake yields (its `request`
 * already carries the token and the server base). The router comes last, in
 * {@link StrengthRouter}, so nothing routes until the handshake is done.
 */
const App = ({ basepath }: AppProps): JSX.Element => {
  const handshake = useSmartHandshake()
  // A failed exchange has nothing to retry here (the code is single-use), so
  // carry the reason to the app root, which can offer the connect menu.
  useLaunchFailureRedirect(handshake)

  const body = Match.value(handshake).pipe(
    Match.when({ kind: 'error' }, ({ error }) => <ErrorBanner error={error} />),
    Match.when({ kind: 'connecting' }, () => <LoadingLine />),
    Match.when({ kind: 'ready' }, ({ client }) => (
      <LaunchedStrength client={client} basepath={basepath} />
    )),
    Match.exhaustive
  )

  return <main className={styles['app']}>{body}</main>
}

export { App, type AppProps, StrengthRouter, type StrengthRouterProps }
