import type { JSX } from 'react'
import { StatusBadge } from 'react-tundraish'

import { ContextCard } from '../atoms/context-card.tsx'
import styles from './subject-selector.module.css'

/** The FHIR subject scope a picker section targets — one patient (`patient/`) or all (`system/`). */
type SubjectContext = 'patient' | 'system'

interface SubjectSelectorProps {
  readonly value: SubjectContext
  readonly onChange: (context: SubjectContext) => void
}

/**
 * The one-patient / all-patients subject selector (open / expandable mode) — a radio pair of
 * {@link ContextCard}s that picks the FHIR context new rules target: `patient/` (the launch
 * patient's own records) or `system/` (every patient). Both options carry equal, neutral weight
 * — `system/` is a legitimate pick, not an alarm (`spec.md §9`); there is no elevated/red
 * treatment and no step-up gate. The composing surface decides when to show it (expandable mode
 * where both contexts are grantable).
 */
const SubjectSelector = ({ value, onChange }: SubjectSelectorProps): JSX.Element => (
  <div role="radiogroup" aria-label="Whose records this applies to" className={styles['group']}>
    <ContextCard
      label="Just this patient"
      sublabel="Access is limited to the launch patient's own records."
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
)

export { SubjectSelector, type SubjectSelectorProps, type SubjectContext }
