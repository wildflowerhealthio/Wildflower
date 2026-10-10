import { useQuery } from '@tanstack/react-query'
import { Effect, Match, Option } from 'effect'
import { fetchPatient } from 'fhir-r4-react/smart'
import type { JSX } from 'react'
import { LinkButton } from 'react-tundraish'

import type { PatientChoice } from './patient-choice.ts'
import { patientLineOf } from './patient-line.ts'
import { ReadFailureLine } from './read-status-lines.tsx'
import type { SmartClient } from './smart-client.ts'
import styles from './patient-choice-line.module.css'

/** Props for {@link PatientChoiceLine}. */
interface PatientChoiceLineProps {
  /** The SMART client the patient is read through. */
  readonly client: SmartClient
  /** Whose records the page reads. */
  readonly patientChoice: PatientChoice
  /** Called when the reader asks to choose again: back to the `PatientPicker`. */
  readonly onPatientChange: () => void
}

/** The patient's name and birth date, from one `Patient` read; nothing until it lands. */
const PatientNameLine = ({
  client,
  patientId,
}: {
  readonly client: SmartClient
  readonly patientId: string
}): JSX.Element | null => {
  const patient = useQuery({
    queryKey: ['patient', patientId],
    queryFn: () => Effect.runPromise(fetchPatient(client, patientId)),
  })
  if (patient.isError) return <ReadFailureLine subject="the patient" error={patient.error} />
  if (patient.data === undefined) return null
  if (Option.isNone(patient.data)) {
    return <ReadFailureLine subject={`patient ${patientId}`} error="not a FHIR Patient" />
  }
  return <span>{patientLineOf(patient.data.value)}</span>
}

/**
 * Whose records the page is showing, under its title: the patient as
 * `Name · born YYYY-MM-DD`, or "All patients", then a "Change patient" link
 * back to the picker.
 */
const PatientChoiceLine = ({
  client,
  patientChoice,
  onPatientChange,
}: PatientChoiceLineProps): JSX.Element => (
  <div className={styles['patient-choice-line']}>
    {Match.value(patientChoice).pipe(
      Match.when({ kind: 'patient' }, ({ patientId }) => (
        <PatientNameLine client={client} patientId={patientId} />
      )),
      Match.when({ kind: 'all-patients' }, () => <span>All patients</span>),
      Match.exhaustive
    )}
    <LinkButton onClick={onPatientChange}>Change patient</LinkButton>
  </div>
)

export { PatientChoiceLine, type PatientChoiceLineProps }
