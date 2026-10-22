import { useQuery } from '@tanstack/react-query'
import type { SmartClient } from '@wildflowerhealthio/fhir-r4-react/smart'
import { cn } from '@wildflowerhealthio/react-kitchen-sink'
import { LinkButton } from '@wildflowerhealthio/react-tundraish'
import { Match, Option } from 'effect'
import type { ComponentProps, JSX } from 'react'

import type { PatientChoice } from './patient-choice.ts'
import { patientLineOf } from './patient-line.ts'
import { patientQuery } from './patient-query.ts'
import { ReadFailureLine } from './read-status-lines.tsx'
import styles from './patient-choice-line.module.css'

/**
 * Props for {@link PatientChoiceLine}: its own three, and any other `<div>`
 * prop (`id`, `aria-*`, `data-*`, a `className` added to its own), which go
 * to the root `<div>`.
 */
interface PatientChoiceLineProps extends Omit<ComponentProps<'div'>, 'children'> {
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
  if (Option.isNone(patientRead.data)) {
    return (
      <ReadFailureLine subject={`patient ${patientId}`} error="no such patient on this server" />
    )
  }
  return <span>{patientLineOf(patientRead.data.value)}</span>
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
  className,
  ...rootProps
}: PatientChoiceLineProps): JSX.Element => (
  <div {...rootProps} className={cn(styles['patient-choice-line'], className)}>
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
