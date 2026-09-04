import type { JSX } from 'react'
import { useMemo } from 'react'

import {
  groupMedications,
  sponsorProgramLabels,
  type Medication,
  type Province,
  type SponsorCatalog,
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
  readonly province: Province
  readonly onProvinceChange: (province: Province) => void
  readonly catalogs: readonly SponsorCatalog[]
}

/**
 * The **prescription savings** page: the province picker on top, then one
 * section per savings program — the program's own description (linked to its
 * site) and the patient's medications it covers in the selected province —
 * and a closing "No known savings program" section for the rest. Eligibility
 * is strictly per selected province: a drug covered only elsewhere lands in
 * the uncovered section.
 */
export const SavingsView = ({
  medications,
  province,
  onProvinceChange,
  catalogs,
}: SavingsViewProps): JSX.Element => {
  const grouped = useMemo(
    () => groupMedications(medications, { province, catalogs }),
    [medications, province, catalogs]
  )

  return (
    <div className={styles.sections}>
      <ProvincePicker value={province} onChange={onProvinceChange} />
      {grouped.sponsored.map((group) => (
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
          {group.items.length > 0 ? (
            <ul className={styles.list}>
              {group.items.map((item) => (
                <li key={item.medication.id} className={styles.row}>
                  <span className={styles.name}>{item.medication.displayName}</span>
                  <SponsorChip sponsor={group.sponsor} drug={item.match.drug} />
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.empty}>
              None of your medications are covered by this program in {province}.
            </p>
          )}
        </section>
      ))}
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
