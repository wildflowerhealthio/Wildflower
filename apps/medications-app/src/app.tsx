import { skipToken, useQuery } from '@tanstack/react-query'
import { fetchMedicationRequests, useSmartHandshake } from 'fhir-r4-react/smart'
import type { Province } from 'medication-sponsorship-core'
import {
  MedicationsView,
  medicationRequestsToMedicationViews,
  ProvincePicker,
} from 'medication-sponsorship-react'
import type { JSX } from 'react'
import { useState } from 'react'

import { catalogs } from './catalogs.ts'
import styles from './app.module.css'

/** The load-failure line, shown for a failed token exchange or a failed read. */
const ErrorLine = ({ error }: { readonly error: unknown }): JSX.Element => (
  <p className={styles.error}>
    Could not load medications: {error instanceof Error ? error.message : String(error)}
  </p>
)

/**
 * The redirect-target app: completes the SMART handshake, loads the patient's
 * MedicationRequests, and renders them grouped by sponsorship program with a
 * province filter.
 *
 * @remarks
 * Both async legs are TanStack Queries on the page's shared client: the token
 * exchange (`useSmartHandshake`, keyed and deduped so StrictMode's double-mount
 * exchanges the single-use code once) and the MedicationRequest read that
 * follows it. The read is `skipToken`-gated on the handshake resolving, which
 * also narrows `client` to defined inside the query function — no non-null
 * assertion.
 */
export const App = (): JSX.Element => {
  const [province, setProvince] = useState<Province>('ON')
  const handshake = useSmartHandshake()
  const client = handshake.kind === 'ready' ? handshake.client : undefined

  const medications = useQuery({
    queryKey: ['medications'],
    // `client.patient.id` is `null` under a `system/` launch (no patient
    // context); `fetchMedicationRequests` then reads across every patient the
    // granted scopes expose rather than failing.
    queryFn:
      client === undefined
        ? skipToken
        : async () =>
            medicationRequestsToMedicationViews(await fetchMedicationRequests(client, null)),
  })

  // Either leg can fail — the token exchange or the read that follows it.
  // Surface whichever did; loading covers both the exchange and the read.
  const body = ((): JSX.Element => {
    if (handshake.kind === 'error') return <ErrorLine error={handshake.error} />
    if (medications.isError) return <ErrorLine error={medications.error} />
    if (medications.isSuccess) {
      return (
        <MedicationsView medications={medications.data} province={province} catalogs={catalogs} />
      )
    }
    return <p className={styles.status}>Loading medications…</p>
  })()

  return (
    <main className={styles.app}>
      <header className={styles.header}>
        <h1 className="text-heading-3">Medications</h1>
        <ProvincePicker value={province} onChange={setProvince} />
      </header>
      {body}
    </main>
  )
}
