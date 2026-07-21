import type { JSX } from 'react'
import { useMemo } from 'react'

import {
  groupMedications,
  type Province,
  type SponsorCatalog,
  type SponsoredDrug,
  type SponsorProgram,
} from 'sponsorship-core'

import { describeDayFromNow, type MedicationView } from './medication.ts'
import { SponsorChip } from './sponsor-chip.tsx'
import styles from './medications-view.module.css'

interface MedicationsViewProps {
  readonly medications: readonly MedicationView[]
  readonly province: Province
  readonly catalogs: readonly SponsorCatalog[]
}

/** The sponsor + matched drug that make a medication eligible in the province. */
interface Eligibility {
  readonly sponsor: SponsorProgram
  readonly drug: SponsoredDrug
}

const statusRank = (status: string | undefined): number => (status === 'active' ? 0 : 1)

/**
 * Active medications first, then most-recently authored first; undated rows
 * sort last. `authoredOn` is an ISO string, so lexical compare is chronological.
 */
const byActiveThenNewest = (a: MedicationView, b: MedicationView): number => {
  const rank = statusRank(a.medication.status) - statusRank(b.medication.status)
  if (rank !== 0) return rank
  const left = a.medication.authoredOn
  const right = b.medication.authoredOn
  if (left === undefined && right === undefined) return 0
  if (left === undefined) return 1
  if (right === undefined) return -1
  return right.localeCompare(left)
}

/**
 * The repeats status as a single self-describing line: `"2 / 3 Repeats
 * Available"`, or `"No Repeats"` when none are allowed (or the count is absent).
 * A missing available count with repeats allowed reads as `0` remaining.
 */
const repeatsSummary = (allowed: number | null, available: number | null): string =>
  allowed === null || allowed <= 0
    ? 'No Repeats'
    : `${available ?? 0} / ${allowed} Repeats Available`

/**
 * Renders the patient's medications as a single flat list — active first, then
 * newest authored first. Each row shows the medication name, DIN, description,
 * status/date, prescriber, estimated next-fill day (with a coarse "in 3 days"
 * hint), a combined repeats summary and notes, plus a sponsorship chip (with a
 * coverage link) when a program in `catalogs` covers it in the selected
 * `province`. Eligibility is computed via `sponsorship-core`'s
 * {@link groupMedications} and memoized on its inputs.
 */
export const MedicationsView = ({
  medications,
  province,
  catalogs,
}: MedicationsViewProps): JSX.Element => {
  // Sampled once per render so every row's relative next-fill hint agrees.
  const nowMillis = Date.now()
  const eligibility = useMemo(() => {
    const grouped = groupMedications(
      medications.map((view) => view.medication),
      { province, catalogs }
    )
    const byId = new Map<string, Eligibility>()
    for (const group of grouped.sponsored) {
      for (const item of group.items) {
        byId.set(item.medication.id, { sponsor: group.sponsor, drug: item.match.drug })
      }
    }
    return byId
  }, [medications, province, catalogs])

  const ordered = useMemo(() => [...medications].toSorted(byActiveThenNewest), [medications])

  if (ordered.length === 0) {
    return <p className={styles.empty}>No medications found.</p>
  }

  return (
    <ul className={styles.list}>
      {ordered.map((view) => {
        const eligible = eligibility.get(view.medication.id)
        return (
          <li key={view.medication.id} className={styles.row}>
            {/* Line 1 left: name · description */}
            <p className={styles.primary}>
              <span className={styles.name}>{view.medication.displayName}</span>
              {view.description !== null && (
                <>
                  <span className={styles.sep}> · </span>
                  <span className={styles.description}>{view.description}</span>
                </>
              )}
            </p>
            {/* Line 1 right: eligibility · pharmacy-location button · DIN */}
            <p className={styles.identity}>
              {eligible !== undefined && (
                <SponsorChip sponsor={eligible.sponsor} drug={eligible.drug} />
              )}
              {view.rexallStoreUrl !== null && (
                <a
                  className={styles.pharmacyLink}
                  href={view.rexallStoreUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Rexall
                </a>
              )}
              {view.din !== null && <span className={styles.din}>DIN {view.din}</span>}
            </p>
            {/* Line 2 left: status · repeats */}
            <p className={styles.statusLine}>
              {view.medication.status !== undefined && (
                <>
                  <span className={styles.status}>{view.medication.status}</span>
                  <span className={styles.sep}> · </span>
                </>
              )}
              <span className={styles.repeats}>
                {repeatsSummary(view.repeatsAllowed, view.repeatsAvailable)}
              </span>
            </p>
            {/* Line 2 right: prescriber */}
            {view.requester !== null && (
              <p className={styles.prescriber}>
                <span className={styles.factValue}>Dr. {view.requester}</span>
              </p>
            )}
            {/* Line 3: next fill */}
            {view.nextFillDate !== null && (
              <p className={styles.nextFill}>
                <span className={styles.factLabel}>Next fill</span>{' '}
                <time dateTime={view.nextFillDate}>{view.nextFillDate.slice(0, 10)}</time>{' '}
                <span className={styles.relative}>
                  {describeDayFromNow(view.nextFillDate, nowMillis)}
                </span>
              </p>
            )}
            {/* Line 4: note */}
            {view.note !== null && <p className={styles.note}>{view.note}</p>}
          </li>
        )
      })}
    </ul>
  )
}

export type { MedicationsViewProps }
