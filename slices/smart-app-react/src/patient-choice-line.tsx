import { useQuery } from '@tanstack/react-query'
import type { SmartClient } from '@wildflowerhealthio/fhir-r4-react/smart'
import { LinkButton } from '@wildflowerhealthio/react-tundraish'
import { Match } from 'effect'
import type { JSX } from 'react'

import type { PatientChoice } from './patient-choice.ts'
import { patientLineOf } from './patient-line.ts'
import { patientQuery } from './patient-query.ts'
import { ReadFailureLine } from './read-status-lines.tsx'
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
  const patientRead = useQuery(patientQuery(client, patientId))
  if (patientRead.isError) {
    return <ReadFailureLine subject="the patient" error={patientRead.error} />
  }
  if (patientRead.data === undefined) return null
  return Match.value(patientRead.data).pipe(
    Match.when({ kind: 'found' }, ({ patient }) => <span>{patientLineOf(patient)}</span>),
    Match.when({ kind: 'not-a-patient' }, () => (
      <ReadFailureLine subject={`patient ${patientId}`} error="not a FHIR Patient" />
    )),
    Match.when({ kind: 'missing' }, () => (
      <ReadFailureLine subject={`patient ${patientId}`} error="no such patient on this server" />
    )),
    Match.exhaustive
  )
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
