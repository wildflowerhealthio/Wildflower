import type { JSX } from 'react'
import { useMemo } from 'react'

import type { MedicationView } from 'medication-core/fhir'

import styles from './medications-view.module.css'

interface MedicationsViewProps {
  readonly medications: readonly MedicationView[]
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
 * The repeats status as a self-describing label plus a `danger` flag:
 * - no repeats allowed (or count absent) → `"No Repeats"` (neutral)
 * - allowed but none remaining (`0 / N`) → `"No Repeats Remaining"` (danger)
 * - some remaining → `"2 / 3 Repeats Available"` (neutral)
 *
 * A missing available count with repeats allowed reads as `0` remaining.
 */
const repeatsSummary = (
  allowed: number | null,
  available: number | null
): { readonly text: string; readonly danger: boolean } => {
  if (allowed === null || allowed <= 0) return { text: 'No Repeats', danger: false }
  const remaining = available ?? 0
  if (remaining <= 0) return { text: 'No Repeats Remaining', danger: true }
  return { text: `${remaining} / ${allowed} Repeats Available`, danger: false }
}

/**
 * Renders the patient's medications split into an "Active Medications" section
 * and a "Completed" section (shown only when non-empty), each newest-authored
 * first. Every row shows the medication name, pharmacy-location links, DIN +
 * description, the repeats summary, prescriber and notes. The layout is a
 * mobile-first vertical stack that wraps on narrow screens and right-aligns
 * the pharmacy actions on wider ones. Savings-program eligibility and fill
 * timing live on their own pages (the savings and calendar views).
 */
export const MedicationsView = ({ medications }: MedicationsViewProps): JSX.Element => {
  const ordered = useMemo(() => [...medications].toSorted(byActiveThenNewest), [medications])

  const row = (view: MedicationView): JSX.Element => {
    const repeats = repeatsSummary(view.repeatsAllowed, view.repeatsAvailable)
    return (
      <li key={view.medication.id} className={styles.row}>
        {/* Name + right-aligned pharmacy actions (wrap on mobile). */}
        <p className={styles.header}>
          <span className={styles.name}>{view.medication.displayName}</span>
          {view.storeLink !== null && (
            <span className={styles.actions}>
              <a
                className={styles.pharmacyLink}
                href={view.storeLink.url}
                target="_blank"
                rel="noreferrer"
              >
                {view.storeLink.label}
              </a>
            </span>
          )}
        </p>
        {/* Description · DIN */}
        {(view.description !== null || view.din !== null) && (
          <p className={styles.secondary}>
            {view.description !== null && <span>{view.description}</span>}
            {view.description !== null && view.din !== null && (
              <span className={styles.sep}> · </span>
            )}
            {view.din !== null && <span className={styles.din}>DIN {view.din}</span>}
          </p>
        )}
        {/* Repeats line; fill timing lives on the calendar view. */}
        <p className={styles.meta}>
          <span className={repeats.danger ? styles.repeatsDanger : styles.repeats}>
            {repeats.text}
          </span>
        </p>
        {view.requester !== null && <p className={styles.prescriber}>Dr. {view.requester}</p>}
        {view.note !== null && <p className={styles.note}>{view.note}</p>}
      </li>
    )
  }

  if (ordered.length === 0) {
    return <p className={styles.empty}>No medications found.</p>
  }

  const active = ordered.filter((view) => view.medication.status === 'active')
  const completed = ordered.filter((view) => view.medication.status !== 'active')

  return (
    <div className={styles.sections}>
      <section className={styles.section}>
        <h2 className="text-heading-2">Active Medications</h2>
        {active.length > 0 ? (
          <ul className={styles.list}>{active.map(row)}</ul>
        ) : (
          <p className={styles.empty}>No active medications.</p>
        )}
      </section>
      {completed.length > 0 && (
        <section className={styles.section}>
          <h2 className="text-heading-2">Completed</h2>
          <ul className={styles.list}>{completed.map(row)}</ul>
        </section>
      )}
    </div>
  )
}

export type { MedicationsViewProps }
