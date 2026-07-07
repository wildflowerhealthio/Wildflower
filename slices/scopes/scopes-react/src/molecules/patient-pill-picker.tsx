import { useEffect, useId, useRef, useState, type JSX } from 'react'

import styles from './patient-pill-picker.module.css'

/** One pickable patient — the `{ id, displayName }` option shape the pill list renders. */
interface PatientOption {
  readonly id: string
  readonly displayName: string
}

interface PatientPillPickerProps {
  readonly patients: readonly PatientOption[]
  /** The selected patient id, or `null` when none has been chosen yet. */
  readonly value: string | null
  readonly onChange: (patientId: string) => void
}

/** The pill's call-to-action while nothing is selected yet. */
const SELECT_A_PATIENT_LABEL = 'Select a Patient'

/**
 * The launch-patient control in the consent card's sunken context bar — a
 * compact pill showing the selected patient (per the Scope Picker reference
 * design) that opens a floating list of the account's patients. It offers no
 * "no patient context" option: the picker is only shown while a patient-context
 * scope is granted, so a patient must be chosen.
 */
const PatientPillPicker = ({ patients, value, onChange }: PatientPillPickerProps): JSX.Element => {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const listId = useId()

  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (event: PointerEvent): void => {
      const node = rootRef.current
      const target = event.target
      if (node !== null && target instanceof Node && !node.contains(target)) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return (): void => {
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [open])

  const selected = patients.find((patient) => patient.id === value)
  const pillLabel = selected?.displayName ?? SELECT_A_PATIENT_LABEL

  const pick = (patientId: string): void => {
    onChange(patientId)
    setOpen(false)
  }

  return (
    <div
      ref={rootRef}
      className={styles['patient-picker']}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setOpen(false)
      }}
    >
      <button
        type="button"
        className={styles['patient-pill']}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => {
          setOpen((previous) => !previous)
        }}
      >
        <span aria-hidden="true" className={styles['patient-dot']} />
        {pillLabel}
        <span aria-hidden="true" className={styles['patient-caret']}>
          {open ? '▴' : '▾'}
        </span>
      </button>
      {open ? (
        <div id={listId} className={styles['patient-pop']} role="listbox" aria-label="Patient">
          <p className={styles['patient-pop-eyebrow']}>Patient</p>
          {patients.map((patient) => (
            <button
              key={patient.id}
              type="button"
              role="option"
              aria-selected={patient.id === value}
              className={styles['patient-option']}
              onClick={() => {
                pick(patient.id)
              }}
            >
              {patient.displayName}
              <code className={styles['patient-option-id']}>{patient.id}</code>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export { PatientPillPicker, type PatientOption, type PatientPillPickerProps }
