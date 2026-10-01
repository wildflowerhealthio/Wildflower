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
  /**
   * Chooses no patient. Present ⇒ the list leads with a "No patient" option and the
   * pill shows it while `value` is `null`. Absent ⇒ a patient must be chosen.
   */
  readonly onChooseNoPatient?: () => void
}

/** The pill's call-to-action while nothing is selected yet. */
const SELECT_A_PATIENT_LABEL = 'Select a Patient'

/** The pill and list label for choosing no patient, when the composer offers it. */
const NO_PATIENT_LABEL = 'No patient'

/**
 * The launch-patient control in the consent card's sunken context bar — a
 * compact pill showing the selected patient (per the Scope Picker reference
 * design) that opens a floating list of the account's patients. It offers a
 * "No patient" option only when the composer passes
 * {@link PatientPillPickerProps.onChooseNoPatient}; otherwise a patient must be chosen.
 */
const PatientPillPicker = ({
  patients,
  value,
  onChange,
  onChooseNoPatient,
}: PatientPillPickerProps): JSX.Element => {
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
  const pillLabel =
    selected?.displayName ??
    (value === null && onChooseNoPatient !== undefined ? NO_PATIENT_LABEL : SELECT_A_PATIENT_LABEL)

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
          {onChooseNoPatient !== undefined ? (
            <button
              type="button"
              role="option"
              aria-selected={value === null}
              className={styles['patient-option']}
              onClick={() => {
                onChooseNoPatient()
                setOpen(false)
              }}
            >
              {NO_PATIENT_LABEL}
            </button>
          ) : null}
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
