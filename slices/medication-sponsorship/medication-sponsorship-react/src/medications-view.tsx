import type { JSX } from 'react'
import { useMemo, useSyncExternalStore } from 'react'

// Never-fires subscribe; useNowMillis snapshots Date.now() on renders the
// caller already commits without also driving one per clock tick.
const noopSubscribe = (): (() => void) => (): void => {}

import {
  groupMedications,
  type Province,
  type SponsorCatalog,
  type SponsoredDrug,
  type SponsorProgram,
} from 'medication-sponsorship-core'

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
 * first. Every row shows the medication name, an eligibility chip (linking to
 * coverage) and pharmacy-location button, DIN + description, a combined
 * next-fill / repeats line, prescriber and notes. The layout is a mobile-first
 * vertical stack that wraps on narrow screens and right-aligns the chip/pharmacy
 * actions on wider ones. Eligibility is computed via `medication-sponsorship-core`'s
 * {@link groupMedications} and memoized on its inputs.
 */
export const MedicationsView = ({
  medications,
  province,
  catalogs,
}: MedicationsViewProps): JSX.Element => {
  // Read as an external-store snapshot so `Date.now()` doesn't run during
  // render (react/purity forbids that — it makes the output depend on
  // wall-clock time and defeats React Compiler memoization). The subscribe
  // is a no-op: we don't want a re-render on every clock tick, only a
  // fresh sample on renders the caller was going to do anyway. Same
  // per-render pinning as before, so every row's relative next-fill hint
  // still agrees.
  const nowMillis = useSyncExternalStore(
    noopSubscribe,
    () => Date.now(),
    () => Date.now()
  )
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

  const row = (view: MedicationView): JSX.Element => {
    const eligible = eligibility.get(view.medication.id)
    const repeats = repeatsSummary(view.repeatsAllowed, view.repeatsAvailable)
    // With repeats left, the supply-runout date is the next fill; with none, it
    // is simply when the supply is exhausted (nothing left to fill).
    const hasRefill =
      view.repeatsAllowed !== null && view.repeatsAllowed > 0 && (view.repeatsAvailable ?? 0) > 0
    const fillLabel = hasRefill ? 'Next fill' : 'Supply exhausted'
    return (
      <li key={view.medication.id} className={styles.row}>
        {/* Name + right-aligned eligibility / pharmacy actions (wrap on mobile). */}
        <p className={styles.header}>
          <span className={styles.name}>{view.medication.displayName}</span>
          {(eligible !== undefined ||
            view.rexallStoreUrl !== null ||
            view.shoppersStoreUrl !== null) && (
            <span className={styles.actions}>
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
              {view.shoppersStoreUrl !== null && (
                <a
                  className={styles.pharmacyLink}
                  href={view.shoppersStoreUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Shoppers
                </a>
              )}
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
        {/* Combined next-fill / supply-exhausted date + repeats line. */}
        <p className={styles.meta}>
          <span className={repeats.danger ? styles.repeatsDanger : styles.repeats}>
            {repeats.text}
          </span>
          {view.nextFillDate !== null && <span className={styles.sep}> · </span>}
          {view.nextFillDate !== null && (
            <span className={styles.metaItem}>
              <span className={styles.factLabel}>{fillLabel}</span>{' '}
              <time dateTime={view.nextFillDate}>{view.nextFillDate.slice(0, 10)}</time>{' '}
              <span>{describeDayFromNow(view.nextFillDate, nowMillis)}</span>
            </span>
          )}
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
