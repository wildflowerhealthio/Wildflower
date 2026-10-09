import { Either, Match } from 'effect'
import type { PebbleSettings } from 'fhir-sync-pebble-core-js'
import type { ReturnTarget, ReturnTargetStore } from 'pebble-configuration'
import type { JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { ErrorBanner } from 'react-tundraish'

import { PatientConfirmation } from './patient-confirmation.tsx'
import styles from './settings-page.module.css'

/** Why the page will not hand the settings off, in the user's terms. */
const refusalMessage = (
  refusal: PebbleSettings.MissingGrantError | ReturnTarget.ForeignReturnTargetError
): string =>
  Match.valueTags(refusal, {
    MissingGrantError: () =>
      'The server did not grant an access token, so there is nothing to give the watch. ' +
      "Open this page again from the watchapp's settings and sign in again.",
    ForeignReturnTargetError: () =>
      'This page was opened with a return address that is not the Pebble app, so it will ' +
      "not send your connection there. Open it again from the watchapp's settings.",
  })

/** Props for {@link SettingsPage}. */
interface SettingsPageProps {
  /** The connection the SMART grant carried, or why it carried none. */
  readonly connection: Either.Either<PebbleSettings.Connection, PebbleSettings.MissingGrantError>
  /** Where `main.tsx` kept the Pebble phone app's `return_to`. */
  readonly returnTargets: ReturnTargetStore.Store
  /** Leaves the page for the hand-off URL. */
  readonly navigate: (url: string) => void
}

/**
 * The settings page the Pebble phone app shows once the user has signed in:
 * the server's patients to pick the one the watch will sync to, and the save
 * that sends the connection back to the watch — or, when the page cannot hand
 * off safely, why not.
 *
 * @remarks
 * The hand-off needs both the connection and the return target, so the two are
 * combined with `Either.all`; the first refusal is matched on its tag in
 * {@link refusalMessage}.
 */
const SettingsPage = ({ connection, returnTargets, navigate }: SettingsPageProps): JSX.Element => {
  const handoff = Either.all({ connection, returnTarget: returnTargets.recall() })

  const confirmationOrError = Either.match(handoff, {
    // oxlint-disable-next-line react/no-unstable-nested-components
    onLeft: (left) => <ErrorBanner error={refusalMessage(left)} />,
    // oxlint-disable-next-line react/no-unstable-nested-components
    onRight: ({ connection: grantedConnection, returnTarget }) => (
      <PatientConfirmation
        connection={grantedConnection}
        returnTarget={returnTarget}
        navigate={navigate}
      />
    ),
  })

  return (
    <>
      <header className={styles['header']}>
        <h1 className="text-heading-3">FHIR Sync for Pebble</h1>
        <p className={cn(styles['subtitle'], 'text-body-3')}>
          Pick the patient, then save to start syncing your Pebble&apos;s steps, sleep and heart
          rate to their record.
        </p>
      </header>

      {confirmationOrError}
    </>
  )
}

export { SettingsPage, type SettingsPageProps }
