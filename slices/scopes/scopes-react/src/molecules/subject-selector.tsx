import type { JSX } from 'react'
import { StatusBadge } from 'react-tundraish'

import { ContextCard } from '../atoms/context-card.tsx'
import { PatientPillPicker, type PatientOption } from './patient-pill-picker.tsx'
import styles from './subject-selector.module.css'

/** The FHIR subject scope a picker section targets — one patient (`patient/`) or all (`system/`). */
type SubjectContext = 'patient' | 'system'

interface SubjectSelectorProps {
  readonly value: SubjectContext
  readonly onChange: (context: SubjectContext) => void
  /**
   * The account's patients, when the surface can actually name one (the answering
   * side of a device authorization). Present ⇒ picking "Just one patient" reveals a
   * {@link PatientPillPicker} to choose *which* patient. Absent (the requesting side,
   * which can't see the account's patients) ⇒ the cards stand alone.
   */
  readonly patients?: readonly PatientOption[]
  /** The chosen patient id (`patients` mode), or `null` when none picked yet. */
  readonly patientId?: string | null
  readonly onPatientChange?: (patientId: string) => void
  /**
   * Whether to render the one-patient / all-patients context radios. `false` drops them and
   * keeps only the which-patient pill — for the patient-only envelope, where `system/` isn't
   * grantable so there's no "whose records" choice to make, but a launch patient must still be
   * named. Defaults to `true` (both radios shown).
   */
  readonly showContextChoice?: boolean
}

/**
 * The one-patient / all-patients subject selector (open / expandable mode) — a radio pair of
 * {@link ContextCard}s that picks the FHIR context new rules target: `patient/` (a single
 * patient's records) or `system/` (every patient). Both options carry equal, neutral weight
 * — `system/` is a legitimate pick, not an alarm (`spec.md §9`); there is no elevated/red
 * treatment and no step-up gate. The composing surface decides when to show it (expandable mode
 * where both contexts are grantable) and whether the concrete patient is choosable
 * ({@link SubjectSelectorProps.patients}).
 */
const SubjectSelector = ({
  value,
  onChange,
  patients,
  patientId = null,
  onPatientChange,
  showContextChoice = true,
}: SubjectSelectorProps): JSX.Element => (
  <div className={styles['selector']}>
    {showContextChoice ? (
      <div role="radiogroup" aria-label="Whose records this applies to" className={styles['group']}>
        <ContextCard
          label="Just one patient"
          sublabel="Access is limited to a single patient's records."
          code="patient/"
          selected={value === 'patient'}
          onSelect={() => {
            onChange('patient')
          }}
        />
        <ContextCard
          label="All patients"
          sublabel="Access spans every patient's records."
          code="system/"
          selected={value === 'system'}
          badge={<StatusBadge tone="neutral">Everyone</StatusBadge>}
          onSelect={() => {
            onChange('system')
          }}
        />
      </div>
    ) : null}
    {value === 'patient' && patients !== undefined && onPatientChange !== undefined ? (
      <div className={styles['patient']}>
        <PatientPillPicker patients={patients} value={patientId} onChange={onPatientChange} />
      </div>
    ) : null}
  </div>
)

export { SubjectSelector, type SubjectSelectorProps, type SubjectContext }
export type { PatientOption }
