import type { JSX } from 'react'
import { ErrorBanner } from 'react-tundraish'
import { PatientPillPicker, type PatientOption } from 'scopes-react'

import styles from '../../styles/consent-card.module.css'

/** Props for {@link PatientChoice}. */
interface PatientChoiceProps {
  readonly patients: readonly PatientOption[]
  /** Whether the patient list is still being read. */
  readonly loading: boolean
  /** Why the patient list could not be read, or `null`. */
  readonly error: Error | null
  /** The selected patient id, or `null` when none has been chosen (or "No patient" was). */
  readonly value: string | null
  /**
   * Whether the grant can go without a patient. `true` ⇒ the picker offers a
   * "No patient" choice; `false` ⇒ a patient must be chosen.
   */
  readonly optional: boolean
  readonly onChange: (patientId: string | null) => void
}

/**
 * The consent card's launch-patient control: the {@link PatientPillPicker}
 * once the server's patients are in, or why there is nothing to pick.
 *
 * @remarks
 * Every state is shown, never hidden. A grant with patient-context access
 * cannot be approved without a patient, so an empty or unreadable list has to
 * say so — the owner's way forward is then to turn off the patient-context
 * access below, not to wonder where the picker went. An optional patient (a
 * `launch/patient` grant with no patient-context access) is offered as a pick
 * with a "No patient" choice, which an empty list leaves as the only one.
 */
const PatientChoice = ({
  patients,
  loading,
  error,
  value,
  optional,
  onChange,
}: PatientChoiceProps): JSX.Element => {
  if (loading) return <p className={styles['patient-note']}>Loading patients…</p>
  if (error !== null) {
    return (
      <div className={styles['patient-note']}>
        <ErrorBanner error={error} />
      </div>
    )
  }
  if (patients.length === 0 && !optional) {
    return (
      <p className={styles['patient-note']}>
        This server has no patients to choose from. Turn off patient access below to allow the rest.
      </p>
    )
  }
  return (
    <PatientPillPicker
      patients={patients}
      value={value}
      onChange={onChange}
      onChooseNoPatient={
        optional
          ? (): void => {
              onChange(null)
            }
          : undefined
      }
    />
  )
}

export { PatientChoice, type PatientChoiceProps }
