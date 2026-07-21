import type { JSX } from 'react'
import { useEffect, useState } from 'react'

import { fetchMedicationRequests, readySmartClient } from 'fhir-r4-react/smart'
import type { Province } from 'medication-sponsorship-core'
import {
  MedicationsView,
  type MedicationView,
  medicationRequestsToMedicationViews,
  ProvincePicker,
} from 'medication-sponsorship-react'

import { catalogs } from './catalogs.ts'
import styles from './app.module.css'

type LoadState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ready'; readonly medications: readonly MedicationView[] }

const loadMedications = async (): Promise<readonly MedicationView[]> => {
  const client = await readySmartClient()
  // `client.patient.id` is `null` under a `system/` launch (no patient context);
  // `fetchMedicationRequests` then reads across every patient the granted scopes
  // expose rather than failing.
  const requests = await fetchMedicationRequests(client, null)
  return medicationRequestsToMedicationViews(requests)
}

/**
 * The redirect-target app: completes the SMART handshake, loads the patient's
 * MedicationRequests, and renders them grouped by sponsorship program with a
 * province filter.
 */
export const App = (): JSX.Element => {
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [province, setProvince] = useState<Province>('ON')

  useEffect(() => {
    let cancelled = false
    loadMedications()
      .then((medications) => {
        if (!cancelled) setState({ kind: 'ready', medications })
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            kind: 'error',
            message: error instanceof Error ? error.message : String(error),
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <main className={styles.app}>
      <header className={styles.header}>
        <h1 className={styles.title}>Medications</h1>
        <ProvincePicker value={province} onChange={setProvince} />
      </header>
      {state.kind === 'loading' && <p className={styles.status}>Loading medications…</p>}
      {state.kind === 'error' && (
        <p className={styles.error}>Could not load medications: {state.message}</p>
      )}
      {state.kind === 'ready' && (
        <MedicationsView medications={state.medications} province={province} catalogs={catalogs} />
      )}
    </main>
  )
}
