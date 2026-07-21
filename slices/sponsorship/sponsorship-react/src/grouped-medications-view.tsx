import type { JSX } from 'react'
import { useMemo } from 'react'

import {
  groupMedications,
  type Medication,
  type Province,
  type SponsorCatalog,
  sponsorProgramLabels,
} from 'sponsorship-core'

import { SponsorCard } from './sponsor-card.tsx'
import styles from './grouped-medications-view.module.css'

interface GroupedMedicationsViewProps {
  readonly medications: readonly Medication[]
  readonly province: Province
  readonly catalogs: readonly SponsorCatalog[]
}

const MedicationSummary = ({ medication }: { readonly medication: Medication }): JSX.Element => (
  <div className={styles.summary}>
    <span className={styles.name}>{medication.displayName}</span>
    <span className={styles.meta}>
      {medication.status !== undefined && (
        <span className={styles.status}>{medication.status}</span>
      )}
      {medication.authoredOn !== undefined && (
        <time className={styles.date} dateTime={medication.authoredOn}>
          {medication.authoredOn.slice(0, 10)}
        </time>
      )}
    </span>
  </div>
)

/**
 * Groups the given medications by sponsor program for the selected province
 * (via `sponsorship-core`'s {@link groupMedications}) and renders one section
 * per program plus a "Not sponsored" section. Grouping is memoized on its
 * inputs.
 */
export const GroupedMedicationsView = ({
  medications,
  province,
  catalogs,
}: GroupedMedicationsViewProps): JSX.Element => {
  const grouped = useMemo(
    () => groupMedications(medications, { province, catalogs }),
    [medications, province, catalogs]
  )

  return (
    <div className={styles.groups}>
      {grouped.sponsored.map((group) => (
        <section key={group.sponsor} className={styles.group}>
          <h2 className={styles.heading}>
            {sponsorProgramLabels[group.sponsor]}
            <span className={styles.count}>{group.items.length}</span>
          </h2>
          {group.items.length === 0 ? (
            <p className={styles.empty}>No matching medications.</p>
          ) : (
            <ul className={styles.list}>
              {group.items.map(({ medication, match }) => (
                <li key={medication.id} className={styles.row}>
                  <MedicationSummary medication={medication} />
                  <SponsorCard drug={match.drug} />
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
      <section className={styles.group}>
        <h2 className={styles.heading}>
          Not sponsored
          <span className={styles.count}>{grouped.unsponsored.length}</span>
        </h2>
        {grouped.unsponsored.length === 0 ? (
          <p className={styles.empty}>None.</p>
        ) : (
          <ul className={styles.list}>
            {grouped.unsponsored.map((medication) => (
              <li key={medication.id} className={styles.row}>
                <MedicationSummary medication={medication} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

export type { GroupedMedicationsViewProps }
