import type { JSX, ReactNode } from 'react'
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { cn } from 'react-kitchen-sink'

import type { Medication } from 'medication-core'
import {
  findInteractions,
  type InteractionCatalog,
  type InteractionRow,
  type MedicationGroup,
  type NonDrugGroup,
  type OtcCategory,
  type OtcCategoryGroup,
  otcCategories,
  type OtcDrug,
  type OtcDrugGroup,
  type Severity,
  severityLabels,
  tallyTotal,
  worstSeverity,
} from 'medication-interaction-core'

import { PrescriberAvatar } from './prescriber-avatar.tsx'
import { SeverityBadge } from './severity-badge.tsx'
import styles from './interactions-view.module.css'

/** Resolves a medication to its prescriber's display name, or `null` if unknown. */
type PrescriberLookup = (medication: Medication) => string | null

interface InteractionsViewProps {
  /** The medications to check — the caller decides which statuses qualify. */
  readonly medications: readonly Medication[]
  readonly catalog: InteractionCatalog
  /** The OTC categories to check against; defaults to the curated list. */
  readonly otc?: readonly OtcCategory[] | undefined
  /**
   * Prescriber lookup for the "Between your medications" section: supplies each
   * medication's prescriber avatar and lets a cross-prescriber interaction be
   * flagged. Omitted (the default) hides avatars entirely.
   */
  readonly prescriberOf?: PrescriberLookup | undefined
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

/**
 * One pip on a group header: an interacting counterpart, its worst severity, and
 * — when set — a click that unfolds the counterpart it names, however deeply
 * nested.
 */
interface Pip {
  /**
   * A stable identity for React keying, unique within a single strip (a
   * medication id, or an OTC active name). Distinct from {@link Pip.name}, which
   * can repeat across counterparts that happen to share a display name.
   */
  readonly key: string
  /** The counterpart named on hover (the other medication, or the OTC brand). */
  readonly name: string
  readonly severity: Severity
  /** Reveal the item this pip stands for; the pip is a plain marker without it. */
  readonly onActivate?: (() => void) | undefined
}

/** The most pips a header shows before the rest collapse into a `+N more` marker. */
const pipCap = 12

/** A severity-coloured dot; decorative, so hidden from assistive tech. */
const Dot = ({ severity }: { readonly severity: Severity }): JSX.Element => (
  <i className={[styles.dot, dotClass[severity]].join(' ')} aria-hidden="true" />
)

/** Keep a shown tooltip inside the viewport, offsetting its caret to compensate. */
const clampTip = (tip: HTMLElement | null): void => {
  if (tip === null) return
  tip.style.setProperty('--tip-shift', '0px')
  tip.style.setProperty('--caret-shift', '0px')
  const rect = tip.getBoundingClientRect()
  const margin = 8
  let shift = 0
  if (rect.right > window.innerWidth - margin) shift = window.innerWidth - margin - rect.right
  else if (rect.left < margin) shift = margin - rect.left
  if (shift !== 0) {
    tip.style.setProperty('--tip-shift', `${shift}px`)
    tip.style.setProperty('--caret-shift', `${shift}px`)
  }
}

/**
 * A named pip: a severity-coloured dot with a tooltip that names its counterpart
 * on hover/focus (a small box with a down-caret, kept inside the page). When the
 * pip can unfold its counterpart it is a button — a sibling of, never nested in,
 * the card's toggle — carrying the name and severity as its accessible label.
 * The tooltip is only in the DOM while shown, so hidden ones never widen the page.
 */
const PipDot = ({ pip, small }: { readonly pip: Pip; readonly small?: boolean }): JSX.Element => {
  const [shown, setShown] = useState(false)
  const tipRef = useRef<HTMLSpanElement | null>(null)
  useLayoutEffect(() => {
    if (shown) clampTip(tipRef.current)
  }, [shown])
  const show = useCallback(() => {
    setShown(true)
  }, [])
  const hide = useCallback(() => {
    setShown(false)
  }, [])

  const dot = (
    <span
      className={cn(styles.dot, dotClass[pip.severity], small && styles['dot-small'])}
      aria-hidden="true"
    />
  )
  const tip = shown ? (
    <span ref={tipRef} className={styles.tip}>
      {pip.name}
    </span>
  ) : null
  const pipClass = styles.pip
  if (pip.onActivate === undefined) {
    return (
      <span className={pipClass} aria-hidden="true" onMouseEnter={show} onMouseLeave={hide}>
        {dot}
        {tip}
      </span>
    )
  }
  return (
    <button
      type="button"
      className={pipClass}
      onClick={pip.onActivate}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      aria-label={`${pip.name} — ${severityLabels[pip.severity]}`}
    >
      {dot}
      {tip}
    </button>
  )
}

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
 * A group header's summary as a strip of pips: one per interacting counterpart,
 * most severe first, each naming that counterpart on hover and unfolding it on
 * click. Past {@link pipCap} the remainder collapses into a `+N more` marker —
 * the full set is still one disclosure away.
 */
const PipStrip = ({
  pips,
  small,
}: {
  readonly pips: readonly Pip[]
  readonly small?: boolean
}): JSX.Element => {
  const shown = pips.slice(0, pipCap)
  const overflow = pips.length - shown.length
  return (
    <span className={styles.strip}>
      {shown.map((pip) => (
        <PipDot key={pip.key} pip={pip} small={small} />
      ))}
      {overflow > 0 && <span className={styles['strip-more']}>+{overflow} more</span>}
    </span>
  )
}

/**
 * The pips for a group whose children are the patient's interacting medications;
 * each unfolds the group it sits on (`onExpand`), revealing the rows.
 */
const rowPips = (rows: readonly InteractionRow[], onExpand: () => void): readonly Pip[] =>
  rows.map((row) => ({
    key: row.medication.id,
    name: row.medication.displayName,
    severity: row.severity,
    onActivate: onExpand,
  }))

/** An OTC active labelled with its brands, e.g. `"Doxylamine (Unisom)"`. */
const otcLabel = (entry: OtcDrug): string =>
  entry.brands === undefined ? entry.name : `${entry.name} (${entry.brands})`

/**
 * The pips for an OTC category: one per interacting active, its worst severity,
 * each unfolding the category and that specific active's nested card.
 */
const categoryPips = (
  group: OtcCategoryGroup,
  categoryKey: string,
  expand: (...keys: readonly string[]) => void
): readonly Pip[] =>
  group.drugs.map((drug) => ({
    key: drug.entry.name,
    name: otcLabel(drug.entry),
    severity: worstSeverity(drug.tally) ?? 'unknown',
    onActivate: () => {
      expand(categoryKey, `${categoryKey}/${drug.entry.name}`)
    },
  }))

/** Which groups are open, keyed by a stable id; nothing is open at first. */
const useDisclosures = (): {
  readonly isOpen: (key: string) => boolean
  readonly toggle: (key: string) => void
  readonly expand: (...keys: readonly string[]) => void
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
  const expand = useCallback((...keys: readonly string[]) => {
    setOpen((previous) => {
      const next = new Set(previous)
      for (const key of keys) next.add(key)
      return next
    })
  }, [])
  return { isOpen, toggle, expand }
}

interface GroupCardProps {
  readonly open: boolean
  readonly onToggle: () => void
  readonly name: string
  /** Muted text beside the name: brands, or the group's interaction count. */
  readonly aside?: string | undefined
  /** Muted text right-aligned before the pips (level 2 only). */
  readonly meta?: string | undefined
  readonly pips: readonly Pip[]
  /** A leading element before the name — the prescriber avatar in level 1. */
  readonly leading?: ReactNode
  /** Level 2: the nested card inside an OTC category. */
  readonly nested?: boolean
  /** Rendered only while open. */
  readonly children: ReactNode
}

/**
 * A collapsible group. Only the left of the header — name, summary, avatar — is
 * the disclosure toggle; the pip strip sits beside it as its own controls, so
 * the two never nest. The body is rendered only while open, keeping a large
 * report's DOM small.
 */
const GroupCard = ({
  open,
  onToggle,
  name,
  aside,
  meta,
  pips,
  leading,
  nested = false,
  children,
}: GroupCardProps): JSX.Element => (
  <li className={nested ? styles['card-nested'] : styles.card}>
    <div className={styles['card-header']}>
      <button
        type="button"
        className={styles['card-toggle']}
        aria-expanded={open}
        onClick={onToggle}
      >
        <span
          className={open ? styles['triangle-open'] : styles['triangle-closed']}
          aria-hidden="true"
        />
        {leading}
        <span className={styles['card-title']}>
          <span className={nested ? styles['card-name-nested'] : styles['card-name']}>{name}</span>
          {aside !== undefined && <span className={styles['card-aside']}>{aside}</span>}
        </span>
        {meta !== undefined && <span className={styles['card-meta']}>{meta}</span>}
      </button>
      <PipStrip pips={pips} small={nested} />
    </div>
    {open && children}
  </li>
)

/**
 * The leaf: the medication on the far side, its worst severity, and a link to
 * the DDInter page of the drug that pair is listed on. The name column
 * ellipsises rather than wrapping, so a row never stacks. An optional `leading`
 * element (the prescriber avatar) sits before the name.
 */
const Row = ({
  row,
  leading,
}: {
  readonly row: InteractionRow
  readonly leading?: JSX.Element | undefined
}): JSX.Element => (
  <li className={styles.row}>
    <span className={styles['row-name-cell']}>
      {leading}
      <span className={styles['row-name']} title={row.medication.displayName}>
        {row.medication.displayName}
      </span>
    </span>
    <SeverityBadge severity={row.severity} />
    <a
      className={styles.link}
      href={row.url}
      target="_blank"
      rel="noopener noreferrer"
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

/**
 * The rows of a "Between your medications" card: like {@link Rows}, but each
 * leads with the far medication's prescriber avatar, ringed when that
 * prescriber differs from the one this card sits under.
 */
const MedicationRows = ({
  rows,
  prescriberOf,
  groupPrescriber,
}: {
  readonly rows: readonly InteractionRow[]
  readonly prescriberOf: PrescriberLookup
  readonly groupPrescriber: string | null
}): JSX.Element => (
  <ul className={styles.rows}>
    {rows.map((row) => {
      const prescriber = prescriberOf(row.medication)
      const differs =
        groupPrescriber !== null && prescriber !== null && prescriber !== groupPrescriber
      return (
        <Row
          key={row.medication.id}
          row={row}
          leading={<PrescriberAvatar name={prescriber} ringed={differs} />}
        />
      )
    })}
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
  onExpandSelf,
  prescriberOf,
}: {
  readonly group: MedicationGroup
  readonly open: boolean
  readonly onToggle: () => void
  readonly onExpandSelf: () => void
  readonly prescriberOf?: PrescriberLookup | undefined
}): JSX.Element => {
  const groupPrescriber = prescriberOf?.(group.medication) ?? null
  return (
    <GroupCard
      open={open}
      onToggle={onToggle}
      name={group.medication.displayName}
      aside={interactions(group.rows.length)}
      pips={rowPips(group.rows, onExpandSelf)}
      leading={prescriberOf !== undefined && <PrescriberAvatar name={groupPrescriber} />}
    >
      {prescriberOf === undefined ? (
        <Rows rows={group.rows} />
      ) : (
        <MedicationRows
          rows={group.rows}
          prescriberOf={prescriberOf}
          groupPrescriber={groupPrescriber}
        />
      )}
    </GroupCard>
  )
}

const NonDrugCard = ({
  group,
  open,
  onToggle,
  onExpandSelf,
}: {
  readonly group: NonDrugGroup
  readonly open: boolean
  readonly onToggle: () => void
  readonly onExpandSelf: () => void
}): JSX.Element => (
  <GroupCard
    open={open}
    onToggle={onToggle}
    name={group.drug.name}
    pips={rowPips(group.rows, onExpandSelf)}
  >
    <Rows rows={group.rows} />
  </GroupCard>
)

const OtcDrugCard = ({
  group,
  open,
  onToggle,
  onExpandSelf,
}: {
  readonly group: OtcDrugGroup
  readonly open: boolean
  readonly onToggle: () => void
  readonly onExpandSelf: () => void
}): JSX.Element => (
  <GroupCard
    open={open}
    onToggle={onToggle}
    name={group.entry.name}
    aside={group.entry.brands}
    meta={`${group.rows.length} of your medications`}
    pips={rowPips(group.rows, onExpandSelf)}
    nested
  >
    <Rows rows={group.rows} nested />
  </GroupCard>
)

const OtcCategoryCard = ({
  group,
  isOpen,
  toggle,
  expand,
}: {
  readonly group: OtcCategoryGroup
  readonly isOpen: (key: string) => boolean
  readonly toggle: (key: string) => void
  readonly expand: (...keys: readonly string[]) => void
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
      pips={categoryPips(group, key, expand)}
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
              onExpandSelf={() => {
                expand(drugKey)
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
 * its actives nested) whose headers carry a strip of named severity pips —
 * hover names the counterpart, click unfolds it, however deeply nested — and
 * whose rows, rendered only while open, name the far-side medication with a
 * badge and a "Details" link to DDInter. Computed via
 * `medication-interaction-core`'s {@link findInteractions}, memoized on its
 * inputs; open state is local and starts fully collapsed.
 *
 * @remarks
 * With {@link InteractionsViewProps.prescriberOf} supplied, the "Between your
 * medications" section shows each medication's prescriber as an initials avatar
 * and rings the avatar of any interaction whose two medications were prescribed
 * by different doctors. An empty catalog renders a single notice instead of the
 * sections. The non-drug section explains itself when the catalog carries no
 * non-drug entries (DDInter is a drug–drug database), and any other empty
 * section keeps its heading with a "none listed" line.
 */
export const InteractionsView = ({
  medications,
  catalog,
  otc = otcCategories,
  prescriberOf,
}: InteractionsViewProps): JSX.Element => {
  const report = useMemo(
    () => findInteractions(medications, catalog, otc),
    [medications, catalog, otc]
  )
  const hasNonDrugEntries = useMemo(() => catalog.drugs.some((drug) => drug.nonDrug), [catalog])
  const { isOpen, toggle, expand } = useDisclosures()

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
          <a href={catalog.source.url} target="_blank" rel="noopener noreferrer">
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
              onExpandSelf={() => {
                expand(key)
              }}
              prescriberOf={prescriberOf}
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
              onExpandSelf={() => {
                expand(key)
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
            expand={expand}
          />
        ))}
      </Section>
    </div>
  )
}

export type { InteractionsViewProps, PrescriberLookup }
