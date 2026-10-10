import { FetchHttpClient } from '@effect/platform'
import { useQueryClient } from '@tanstack/react-query'
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
import { type JSX, useMemo } from 'react'

import { LiftingApp } from './lifting-app/lifting-app.tsx'
import type { SmartClient } from './smart-client.ts'
import styles from './app.module.css'

/**
 * The lifting screens over a completed handshake: the patient picker until a
 * patient is chosen, then {@link LiftingApp} for the choice, remounted per
 * choice.
 *
 * @remarks
 * Whose record is `smart-app-react`'s `usePatientChoice`: the URL's
 * `?patient=`, else the launch's patient (`client.patient.id`), else the
 * picker. Writes go through `runAuthed`, the typed client that
 * `buildSmartRouterContext` builds over `FetchHttpClient.layer` — the one
 * shared function that prefixes the FHIR base and sets the bearer header.
 */
const LaunchedLifting = ({ client }: { readonly client: SmartClient }): JSX.Element => {
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
      <LiftingApp
        key={patientChoiceKeyOf(chosenPatient)}
        client={client}
        runAuthed={runAuthed}
        patientChoice={chosenPatient}
        onPatientChange={changePatient}
      />
    ),
  })
}

/**
 * The redirect-target app: completes the SMART handshake, then mounts the
 * lifting screens over it.
 *
 * @remarks
 * Reads go through the fhirclient client the handshake yields (its `request`
 * already carries the token and the server base). There is no router: the
 * lifting screens take plain props.
 */
const App = (): JSX.Element => {
  const handshake = useSmartHandshake()
  // A failed exchange has nothing to retry here (the code is single-use), so
  // carry the reason to the app root, which can offer the connect menu.
  useLaunchFailureRedirect(handshake)

  const body = Match.value(handshake).pipe(
    Match.when({ kind: 'error' }, ({ error }) => <ErrorBanner error={error} />),
    Match.when({ kind: 'connecting' }, () => <LoadingLine />),
    Match.when({ kind: 'ready' }, ({ client }) => <LaunchedLifting client={client} />),
    Match.exhaustive
  )

  return <main className={styles['app']}>{body}</main>
}

export { App }
