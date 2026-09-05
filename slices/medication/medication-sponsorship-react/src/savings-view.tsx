import type { JSX } from 'react'
import { useMemo } from 'react'

import {
  groupMedications,
  sponsorProgramLabels,
  type GroupedMedication,
  type Medication,
  type Province,
  type SponsorCatalog,
  type SponsorProgram,
} from 'medication-sponsorship-core'

import { programDescriptions } from './program-descriptions.ts'
import { ProvincePicker } from './province-picker.tsx'
import { SponsorChip } from './sponsor-chip.tsx'
import styles from './savings-view.module.css'

interface SavingsViewProps {
  /**
   * The medications to group — pass the same deduplicated active list the
   * interactions report checks, so the two pages agree on what "your
   * medications" means.
   */
  readonly medications: readonly Medication[]
  /**
   * Completed (no longer active) prescriptions that are still eligible for a
   * program, shown dimmed at the bottom of each program's list so the patient
   * sees a savings they qualified for on a past fill. Pass those with no active
   * prescription of the same name (an active one already covers the row). They
   * appear only under programs — never in the "No known savings program"
   * section. Defaults to none.
   */
  readonly pastMedications?: readonly Medication[]
  readonly province: Province
  readonly onProvinceChange: (province: Province) => void
  readonly catalogs: readonly SponsorCatalog[]
}

/**
 * One eligibility row: the drug name and its sponsor chip. A `past` row is a
 * completed-but-still-eligible prescription — dimmed and tagged, kept at the
 * bottom of its program's list.
 */
const eligibilityRow = (
  sponsor: SponsorProgram,
  item: GroupedMedication,
  past: boolean
): JSX.Element => (
  // Namespace by past/active so an id shared across both lists doesn't collide as a React key.
  <li
    key={`${past ? 'past' : 'active'}:${item.medication.id}`}
    className={past ? `${styles.row} ${styles.past}` : styles.row}
  >
    <span className={styles.nameCell}>
      <span className={styles.name}>{item.medication.displayName}</span>
      {past && <span className={styles.pastLabel}>Completed</span>}
    </span>
    <SponsorChip sponsor={sponsor} drug={item.match.drug} />
  </li>
)

/**
 * The **prescription savings** page: the province picker on top, then one
 * section per savings program — the program's own description (linked to its
 * site) and the patient's medications it covers in the selected province, with
 * completed-but-still-eligible prescriptions dimmed at the bottom of each list
 * — and a closing "No known savings program" section for the rest. Eligibility
 * is strictly per selected province: a drug covered only elsewhere lands in
 * the uncovered section.
 */
export const SavingsView = ({
  medications,
  pastMedications = [],
  province,
  onProvinceChange,
  catalogs,
}: SavingsViewProps): JSX.Element => {
  const grouped = useMemo(
    () => groupMedications(medications, { province, catalogs }),
    [medications, province, catalogs]
  )
  // Past-but-eligible prescriptions, grouped the same way; only their sponsored
  // matches are shown (uncovered past prescriptions are dropped), keyed by
  // program so each list can append them beneath its active rows.
  const pastBySponsor = useMemo(() => {
    const grouping = groupMedications(pastMedications, { province, catalogs })
    return new Map<SponsorProgram, readonly GroupedMedication[]>(
      grouping.sponsored.map((group) => [group.sponsor, group.items])
    )
  }, [pastMedications, province, catalogs])

  return (
    <div className={styles.sections}>
      <ProvincePicker value={province} onChange={onProvinceChange} />
      {grouped.sponsored.map((group) => {
        const past = pastBySponsor.get(group.sponsor) ?? []
        return (
          <section key={group.sponsor} className={styles.section}>
            <h2 className="text-heading-2">{sponsorProgramLabels[group.sponsor]}</h2>
            <p className={styles.description}>
              {programDescriptions[group.sponsor].text}{' '}
              <a
                className={styles.source}
                href={programDescriptions[group.sponsor].source}
                target="_blank"
                rel="noreferrer"
              >
                Learn more at {new URL(programDescriptions[group.sponsor].source).hostname}
              </a>
            </p>
            {group.items.length + past.length > 0 ? (
              <ul className={styles.list}>
                {group.items.map((item) => eligibilityRow(group.sponsor, item, false))}
                {past.map((item) => eligibilityRow(group.sponsor, item, true))}
              </ul>
            ) : (
              <p className={styles.empty}>
                None of your medications are covered by this program in {province}.
              </p>
            )}
          </section>
        )
      })}
      <section className={styles.section}>
        <h2 className="text-heading-2">No known savings program</h2>
        {grouped.unsponsored.length > 0 ? (
          <ul className={styles.list}>
            {grouped.unsponsored.map((medication) => (
              <li key={medication.id} className={styles.row}>
                <span className={styles.name}>{medication.displayName}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.empty}>Every medication above is covered by a program.</p>
        )}
      </section>
    </div>
  )
}

export type { SavingsViewProps }
