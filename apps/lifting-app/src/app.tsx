import { FetchHttpClient } from '@effect/platform'
import { useQueryClient } from '@tanstack/react-query'
import { Match } from 'effect'
import type { RunAuthed } from 'fhir-r4-react'
import {
  buildSmartRouterContext,
  useLaunchFailureRedirect,
  useSmartHandshake,
} from 'fhir-r4-react/smart'
import { type JSX, useMemo } from 'react'
import { ErrorBanner, GateCard } from 'react-tundraish'
import { LoadingLine } from 'smart-app-react'

import { LiftingApp } from './lifting-app.tsx'
import type { SmartClient } from './smart-client.ts'
import styles from './app.module.css'

/**
 * The redirect-target app: completes the SMART handshake, then mounts
 * {@link LiftingApp} for the patient the launch names.
 *
 * @remarks
 * Reads go through the fhirclient client the handshake yields (its `request`
 * already carries the token and the server base); writes go through
 * `runAuthed`, the typed client that `buildSmartRouterContext` builds over
 * `FetchHttpClient.layer` — the one shared function that prefixes the FHIR
 * base and sets the bearer header. There is no router: the lifting screens
 * take plain props.
 *
 * A program is always some lifter's, so a launch with no patient in context
 * stops at a gate saying so rather than guessing whose record to read or
 * write.
 */
const App = (): JSX.Element => {
  const queryClient = useQueryClient()
  const handshake = useSmartHandshake()
  // A failed exchange has nothing to retry here (the code is single-use), so
  // carry the reason to the app root, which can offer the connect menu.
  useLaunchFailureRedirect(handshake)

  const client: SmartClient | undefined = handshake.kind === 'ready' ? handshake.client : undefined
  // Memoised on the (stable) resolved client, so a re-render does not rebuild
  // the runtime underneath an in-flight write.
  const runAuthed = useMemo<RunAuthed | undefined>(
    () =>
      client === undefined
        ? undefined
        : buildSmartRouterContext(
            {
              serverUrl: client.state.serverUrl,
              accessToken: client.state.tokenResponse?.access_token,
            },
            FetchHttpClient.layer,
            queryClient
          ).runAuthed,
    [client, queryClient]
  )

  const body = Match.value(handshake).pipe(
    Match.when({ kind: 'error' }, ({ error }) => <ErrorBanner error={error} />),
    Match.when({ kind: 'connecting' }, () => <LoadingLine />),
    Match.when({ kind: 'ready' }, ({ client: readyClient }) => {
      const patientId = readyClient.patient.id
      if (patientId === null || runAuthed === undefined) {
        return (
          <GateCard
            title="Lifting needs a patient"
            body="This launch did not name a patient. A program is always someone's, so launch Lifting from a patient's record, or connect again and pick a patient."
            showSpinner={false}
          />
        )
      }
      return <LiftingApp client={readyClient} patientId={patientId} runAuthed={runAuthed} />
    }),
    Match.exhaustive
  )

  return <main className={styles['app']}>{body}</main>
}

export { App }
