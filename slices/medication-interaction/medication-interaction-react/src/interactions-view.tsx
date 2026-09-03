import type { JSX } from 'react'
import { useMemo } from 'react'

import {
  findInteractions,
  type Interaction,
  type InteractionCatalog,
  type InteractionParty,
  type OtcDrug,
  otcDrugs,
} from 'medication-interaction-core'
import type { Medication } from 'medication-matching-core'

import { SeverityBadge } from './severity-badge.tsx'
import styles from './interactions-view.module.css'

interface InteractionsViewProps {
  /** The medications to check — the caller decides which statuses qualify. */
  readonly medications: readonly Medication[]
  readonly catalog: InteractionCatalog
  /** The OTC actives to check against; defaults to the curated list. */
  readonly otc?: readonly OtcDrug[] | undefined
}

/**
 * One side of a row: the DDInter drug name, plus where it came from when
 * that adds information — the patient's medication as prescribed (when its
 * name is not simply the drug name) or the OTC entry's familiar brands.
 */
const Party = ({ party }: { readonly party: InteractionParty }): JSX.Element => {
  const medicationName = party.medication?.displayName
  const origin =
    medicationName !== undefined && medicationName !== party.drug.name
      ? medicationName
      : party.otc?.brands
  return (
    <span className={styles.party}>
      <span className={styles.drug}>{party.drug.name}</span>
      {origin !== undefined && <span className={styles.origin}>{origin}</span>}
    </span>
  )
}

const Row = ({ row }: { readonly row: Interaction }): JSX.Element => (
  <li className={styles.row}>
    <SeverityBadge severity={row.severity} />
    <span className={styles.pair}>
      <Party party={row.a} />
      <span className={styles.plus} aria-hidden="true">
        +
      </span>
      <Party party={row.b} />
    </span>
    <a className={styles.link} href={row.url} target="_blank" rel="noreferrer">
      Details
    </a>
  </li>
)

interface SectionProps {
  readonly title: string
  readonly rows: readonly Interaction[]
  /** Shown in place of the list when there are no rows. */
  readonly empty: string
}

const Section = ({ title, rows, empty }: SectionProps): JSX.Element => (
  <section className={styles.section}>
    <h2 className="text-heading-2">{title}</h2>
    {rows.length > 0 ? (
      <ul className={styles.list}>
        {rows.map((row) => (
          <Row key={`${row.a.drug.index}:${row.b.drug.index}`} row={row} />
        ))}
      </ul>
    ) : (
      <p className={styles.empty}>{empty}</p>
    )}
  </section>
)

/**
 * The interactions report for a set of medications, in three sections:
 * between the medications themselves, with non-drugs (food, alcohol, …), and
 * with common over-the-counter actives. Each row carries a severity badge,
 * the two names (with the prescribed name or OTC brands underneath when they
 * add information) and a "Details" link to the drug's DDInter page. Computed via
 * `medication-interaction-core`'s {@link findInteractions}, memoized on its
 * inputs.
 *
 * @remarks
 * An empty catalog (no data bundled) renders a single notice instead of the
 * sections, since every section would otherwise be an uninformative "none".
 * The non-drug section explains itself when the catalog carries no non-drug
 * entries at all — DDInter is a drug–drug database, so that is the expected
 * state rather than a clean bill of health.
 */
export const InteractionsView = ({
  medications,
  catalog,
  otc = otcDrugs,
}: InteractionsViewProps): JSX.Element => {
  const report = useMemo(
    () => findInteractions(medications, catalog, otc),
    [medications, catalog, otc]
  )
  const hasNonDrugEntries = useMemo(() => catalog.drugs.some((drug) => drug.nonDrug), [catalog])

  if (catalog.drugs.length === 0) {
    return (
      <p className={styles.notice}>
        No interaction database is bundled in this build, so interactions cannot be checked.
      </p>
    )
  }
  if (medications.length === 0) {
    return <p className={styles.empty}>No medications to check.</p>
  }

  return (
    <div className={styles.sections}>
      <p className={styles.disclaimer}>
        Interactions listed by{' '}
        <a href={catalog.source.url} target="_blank" rel="noreferrer">
          {catalog.source.name}
        </a>
        . For information only — talk to a pharmacist or prescriber before changing any medication.
      </p>
      <Section
        title="Between your medications"
        rows={report.knownDrugs}
        empty="No interactions listed between your medications."
      />
      <Section
        title="With food, alcohol and other non-drugs"
        rows={report.nonDrugs}
        empty={
          hasNonDrugEntries
            ? 'No interactions listed with food, alcohol or other non-drugs.'
            : `${catalog.source.name} lists drug–drug interactions only, so there is nothing to check here.`
        }
      />
      <Section
        title="With common over-the-counter drugs"
        rows={report.otc}
        empty="No interactions listed with common over-the-counter drugs."
      />
    </div>
  )
}

export type { InteractionsViewProps }
