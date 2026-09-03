import type { JSX, ReactNode } from 'react'
import { useCallback, useMemo, useState } from 'react'

import {
  allocateDots,
  dotCap,
  findInteractions,
  type InteractionCatalog,
  type InteractionRow,
  type MedicationGroup,
  type NonDrugGroup,
  type OtcCategory,
  type OtcCategoryGroup,
  otcCategories,
  type OtcDrugGroup,
  type Severity,
  severityLabels,
  type SeverityTally,
  tallyTotal,
} from 'medication-interaction-core'
import type { Medication } from 'medication-matching-core'

import { SeverityBadge } from './severity-badge.tsx'
import styles from './interactions-view.module.css'

interface InteractionsViewProps {
  /** The medications to check — the caller decides which statuses qualify. */
  readonly medications: readonly Medication[]
  readonly catalog: InteractionCatalog
  /** The OTC categories to check against; defaults to the curated list. */
  readonly otc?: readonly OtcCategory[] | undefined
}

/** `n` with its noun, pluralised with a plain `s` (or the given plural). */
const count = (n: number, noun: string, plural: string = `${noun}s`): string =>
  `${n} ${n === 1 ? noun : plural}`

const severityOrder: readonly Severity[] = ['major', 'moderate', 'minor', 'unknown']

const dotClass: Readonly<Record<Severity, string>> = {
  major: styles['dot-major'],
  moderate: styles['dot-moderate'],
  minor: styles['dot-minor'],
  unknown: styles['dot-unknown'],
}

/** A severity-coloured dot; decorative, so hidden from assistive tech. */
const Dot = ({
  severity,
  small = false,
}: {
  readonly severity: Severity
  readonly small?: boolean
}): JSX.Element => (
  <i
    className={[styles.dot, dotClass[severity], small ? styles['dot-small'] : ''].join(' ')}
    aria-hidden="true"
  />
)

/** The always-visible key to the dot and badge colours. */
const Legend = (): JSX.Element => (
  <div className={styles.legend}>
    <span className={styles['legend-label']}>Severity</span>
    {severityOrder.map((severity) => (
      <span key={severity} className={styles['legend-item']}>
        <Dot severity={severity} />
        {severityLabels[severity]}
      </span>
    ))}
  </div>
)

/**
 * A group header's summary of its interactions as a strip of dots: one per
 * interaction up to {@link dotCap}, then a proportional mix (see
 * {@link allocateDots}) followed by the true total.
 */
const DotStrip = ({
  tally,
  small,
}: {
  readonly tally: SeverityTally
  readonly small?: boolean
}): JSX.Element => {
  const total = tallyTotal(tally)
  return (
    <span className={styles.strip}>
      {allocateDots(tally).map((severity, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- dots are identical and stateless; their position is their identity
        <Dot key={index} severity={severity} small={small} />
      ))}
      {total > dotCap && <span className={styles['strip-total']}>{total} total</span>}
    </span>
  )
}

/** Which groups are open, keyed by a stable id; nothing is open at first. */
const useDisclosures = (): {
  readonly isOpen: (key: string) => boolean
  readonly toggle: (key: string) => void
} => {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  const isOpen = useCallback((key: string) => open.has(key), [open])
  const toggle = useCallback((key: string) => {
    setOpen((previous) => {
      const next = new Set(previous)
      if (!next.delete(key)) next.add(key)
      return next
    })
  }, [])
  return { isOpen, toggle }
}

interface GroupCardProps {
  readonly open: boolean
  readonly onToggle: () => void
  readonly name: string
  /** Muted text beside the name: brands, or the group's interaction count. */
  readonly aside?: string | undefined
  /** Muted text right-aligned before the dots (level 2 only). */
  readonly meta?: string | undefined
  readonly tally: SeverityTally
  /** Level 2: the nested card inside an OTC category. */
  readonly nested?: boolean
  /** Rendered only while open. */
  readonly children: ReactNode
}

/**
 * A collapsible group: a full-width header button carrying the name, a
 * summary and the dot strip, with the body rendered only while open so a
 * large report keeps a small DOM.
 */
const GroupCard = ({
  open,
  onToggle,
  name,
  aside,
  meta,
  tally,
  nested = false,
  children,
}: GroupCardProps): JSX.Element => (
  <li className={nested ? styles['card-nested'] : styles.card}>
    <button type="button" className={styles['card-header']} aria-expanded={open} onClick={onToggle}>
      <span
        className={open ? styles['triangle-open'] : styles['triangle-closed']}
        aria-hidden="true"
      />
      <span className={styles['card-title']}>
        <span className={nested ? styles['card-name-nested'] : styles['card-name']}>{name}</span>
        {aside !== undefined && <span className={styles['card-aside']}>{aside}</span>}
      </span>
      {meta !== undefined && <span className={styles['card-meta']}>{meta}</span>}
      <DotStrip tally={tally} small={nested} />
    </button>
    {open && children}
  </li>
)

/**
 * The leaf: the medication on the far side, its worst severity, and a link to
 * the DDInter page of the drug that pair is listed on. The name column
 * ellipsises rather than wrapping, so a row never stacks.
 */
const Row = ({ row }: { readonly row: InteractionRow }): JSX.Element => (
  <li className={styles.row}>
    <span className={styles['row-name']} title={row.medication.displayName}>
      {row.medication.displayName}
    </span>
    <SeverityBadge severity={row.severity} />
    <a
      className={styles.link}
      href={row.url}
      target="_blank"
      rel="noreferrer"
      aria-label={`Details for ${row.drug.name} on DDInter`}
    >
      Details
    </a>
  </li>
)

const Rows = ({
  rows,
  nested = false,
}: {
  readonly rows: readonly InteractionRow[]
  readonly nested?: boolean
}): JSX.Element => (
  <ul className={nested ? styles['rows-nested'] : styles.rows}>
    {rows.map((row) => (
      <Row key={row.medication.id} row={row} />
    ))}
  </ul>
)

interface SectionProps {
  readonly title: string
  /** Entity and interaction counts beside the heading; omitted when empty. */
  readonly summary: string | undefined
  /** Shown in place of the list when there are no groups. */
  readonly empty: string
  readonly children: ReactNode
}

const Section = ({ title, summary, empty, children }: SectionProps): JSX.Element => (
  <section className={styles.section}>
    <div className={styles['section-heading']}>
      <h2 className="text-heading-2">{title}</h2>
      {summary !== undefined && <span className={styles['section-summary']}>{summary}</span>}
    </div>
    {summary !== undefined ? (
      <ul className={styles.groups}>{children}</ul>
    ) : (
      <p className={styles.empty}>{empty}</p>
    )}
  </section>
)

const interactions = (n: number): string => count(n, 'potential interaction')

const MedicationCard = ({
  group,
  open,
  onToggle,
}: {
  readonly group: MedicationGroup
  readonly open: boolean
  readonly onToggle: () => void
}): JSX.Element => (
  <GroupCard
    open={open}
    onToggle={onToggle}
    name={group.medication.displayName}
    aside={interactions(group.rows.length)}
    tally={group.tally}
  >
    <Rows rows={group.rows} />
  </GroupCard>
)

const NonDrugCard = ({
  group,
  open,
  onToggle,
}: {
  readonly group: NonDrugGroup
  readonly open: boolean
  readonly onToggle: () => void
}): JSX.Element => (
  <GroupCard
    open={open}
    onToggle={onToggle}
    name={group.drug.name}
    aside={`${group.rows.length} of your medications`}
    tally={group.tally}
  >
    <Rows rows={group.rows} />
  </GroupCard>
)

const OtcDrugCard = ({
  group,
  open,
  onToggle,
}: {
  readonly group: OtcDrugGroup
  readonly open: boolean
  readonly onToggle: () => void
}): JSX.Element => (
  <GroupCard
    open={open}
    onToggle={onToggle}
    name={group.entry.name}
    aside={group.entry.brands}
    meta={`${group.rows.length} of your medications`}
    tally={group.tally}
    nested
  >
    <Rows rows={group.rows} nested />
  </GroupCard>
)

const OtcCategoryCard = ({
  group,
  isOpen,
  toggle,
}: {
  readonly group: OtcCategoryGroup
  readonly isOpen: (key: string) => boolean
  readonly toggle: (key: string) => void
}): JSX.Element => {
  const key = `c:${group.category.name}`
  return (
    <GroupCard
      open={isOpen(key)}
      onToggle={() => {
        toggle(key)
      }}
      name={group.category.name}
      aside={`${count(group.drugs.length, 'drug')} with potential interactions`}
      tally={group.tally}
    >
      <ul className={styles['groups-nested']}>
        {group.drugs.map((drug) => {
          const drugKey = `${key}/${drug.entry.name}`
          return (
            <OtcDrugCard
              key={drugKey}
              group={drug}
              open={isOpen(drugKey)}
              onToggle={() => {
                toggle(drugKey)
              }}
            />
          )
        })}
      </ul>
    </GroupCard>
  )
}

/**
 * The interactions report for a set of medications: three sections of
 * collapsible groups (each medication, each non-drug, each OTC category with
 * its actives nested) whose headers carry a severity dot strip and whose
 * rows, rendered only while open, name the far-side medication with a badge
 * and a "Details" link to DDInter. Computed via `medication-interaction-core`'s
 * {@link findInteractions}, memoized on its inputs; open state is local and
 * starts fully collapsed.
 *
 * @remarks
 * An empty catalog renders a single notice instead of the sections. The
 * non-drug section explains itself when the catalog carries no non-drug
 * entries (DDInter is a drug–drug database), and any other empty section
 * keeps its heading with a "none listed" line.
 */
export const InteractionsView = ({
  medications,
  catalog,
  otc = otcCategories,
}: InteractionsViewProps): JSX.Element => {
  const report = useMemo(
    () => findInteractions(medications, catalog, otc),
    [medications, catalog, otc]
  )
  const hasNonDrugEntries = useMemo(() => catalog.drugs.some((drug) => drug.nonDrug), [catalog])
  const { isOpen, toggle } = useDisclosures()

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

  const medicationRows = report.medications.reduce((sum, group) => sum + group.rows.length, 0)
  const nonDrugRows = report.nonDrugs.reduce((sum, group) => sum + group.rows.length, 0)
  const otcRows = report.otc.reduce((sum, group) => sum + tallyTotal(group.tally), 0)
  const summaryFor = (groups: number, entity: string, rows: number): string | undefined =>
    groups === 0 ? undefined : `${entity} · ${interactions(rows)}`

  return (
    <div className={styles.sections}>
      <div className={styles.intro}>
        <p className={styles.disclaimer}>
          Interactions listed by{' '}
          <a href={catalog.source.url} target="_blank" rel="noreferrer">
            {catalog.source.name}
          </a>
          . For information only — talk to a pharmacist or prescriber before changing any
          medication.
        </p>
        <Legend />
      </div>
      <Section
        title="Between your medications"
        summary={summaryFor(
          report.medications.length,
          `${report.medications.length} of your medications`,
          medicationRows / 2
        )}
        empty="No interactions listed between your medications."
      >
        {report.medications.map((group) => {
          const key = `m:${group.medication.id}`
          return (
            <MedicationCard
              key={key}
              group={group}
              open={isOpen(key)}
              onToggle={() => {
                toggle(key)
              }}
            />
          )
        })}
      </Section>
      <Section
        title="With food, alcohol and other non-drugs"
        summary={summaryFor(
          report.nonDrugs.length,
          count(report.nonDrugs.length, 'non-drug'),
          nonDrugRows
        )}
        empty={
          hasNonDrugEntries
            ? 'No interactions listed with food, alcohol or other non-drugs.'
            : `${catalog.source.name} lists drug–drug interactions only, so there is nothing to check here.`
        }
      >
        {report.nonDrugs.map((group) => {
          const key = `n:${group.drug.index}`
          return (
            <NonDrugCard
              key={key}
              group={group}
              open={isOpen(key)}
              onToggle={() => {
                toggle(key)
              }}
            />
          )
        })}
      </Section>
      <Section
        title="With common over-the-counter drugs"
        summary={summaryFor(
          report.otc.length,
          count(report.otc.length, 'category', 'categories'),
          otcRows
        )}
        empty="No interactions listed with common over-the-counter drugs."
      >
        {report.otc.map((group) => (
          <OtcCategoryCard
            key={group.category.name}
            group={group}
            isOpen={isOpen}
            toggle={toggle}
          />
        ))}
      </Section>
    </div>
  )
}

export type { InteractionsViewProps }
