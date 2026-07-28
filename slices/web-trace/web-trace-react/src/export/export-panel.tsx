import { useId, type ChangeEvent, type JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { ErrorBanner, Field, PageLoading, StatusBadge, ToggleSwitch } from 'react-tundraish'
import type { TraceExchange } from 'web-trace-core'
import type { PathOverride } from 'web-trace-core/pseudonymizer'

import { droppedBodyCount, type PreviewRow } from './redaction-preview.ts'
import { useExport } from './use-export.ts'
import styles from './export-panel.module.css'

/** The `<option>` value standing for "no override — use the policy's own decision". */
const AUTO = 'auto'

/** Props for {@link ExportPanel}. */
interface ExportPanelProps {
  /**
   * The exchanges to export — the open session's, already narrowed by the
   * exchange list's filters.
   *
   * @remarks
   * Must be a **stable** reference across renders (memoise it), since its
   * identity is what triggers a rebuild of the preview.
   */
  readonly exchanges: readonly TraceExchange[]
  /** How many exchanges the session holds before filtering, so the subset can say so. */
  readonly sessionExchangeCount: number
  /** The session being exported; names the archive and its `log.creator`. */
  readonly sessionId: string
  readonly className?: string
}

/** A sample value as a cell, or an em dash when there is none to show. */
const valueCell = (value: string | null): string => (value === null ? '—' : value)

/**
 * What the `Auto` option resolves to for this row, spelled out.
 *
 * @param row - The row the select belongs to
 * @returns The option label, naming the outcome and what produced it
 *
 * @remarks
 * A bare `Auto` makes the reviewer infer the outcome from a second column. The
 * outcome is the thing they are deciding about, so the option says it — and
 * says *why*, because "hidden because it is not a code" and "hidden because
 * there are too many values" have different fixes.
 *
 * A namespace-URI row names its rule instead of its count, in both directions:
 * those paths are exempt from the threshold, so a count would send the
 * reviewer to a control that had no say in the decision.
 */
const autoLabel = (row: PreviewRow): string => {
  const values = `${row.distinctValues} ${row.distinctValues === 1 ? 'value' : 'values'}`
  if (row.decidedBy === 'override') return 'Auto'
  if (row.decidedBy === 'namespaceUri') return 'Auto — visible (schema URL)'
  if (row.decidedBy === 'namespaceUrisOff') return 'Auto — hidden (schema URLs off)'
  if (row.verbatim) return `Auto — visible (${values})`
  if (row.decidedBy === 'disabled') return 'Auto — hidden (codes off)'
  return row.decidedBy === 'notCode' ? 'Auto — hidden (not a code)' : `Auto — hidden (${values})`
}

/** Whether a string is one of the values the override select can produce. */
const isOverrideChoice = (value: string): value is PathOverride | typeof AUTO =>
  value === AUTO || value === 'verbatim' || value === 'pseudonymize'

/** Props for {@link PreviewTable}. */
interface PreviewTableProps {
  readonly rows: readonly PreviewRow[]
  readonly overrides: Readonly<Record<string, PathOverride>>
  readonly onOverride: (path: string, override: PathOverride | null) => void
  /** Heading for the `after` column — the two sections mean different things by it. */
  readonly afterHeading: string
}

/**
 * One section's rows.
 *
 * @remarks
 * Column widths are fixed rather than content-driven: a path key is far longer
 * than the values beside it, so an auto-laid-out table gives the path most of
 * the width and squeezes the before/after columns the reviewer is actually
 * reading into a few characters each.
 */
const PreviewTable = ({
  rows,
  overrides,
  onOverride,
  afterHeading,
}: PreviewTableProps): JSX.Element => (
  <div className={styles['export__table-scroll']}>
    <table className={cn(styles['export__table'], 'text-body-3')}>
      <colgroup>
        <col className={styles['export__col-path']} />
        <col className={styles['export__col-count']} />
        <col className={styles['export__col-value']} />
        <col className={styles['export__col-value']} />
        <col className={styles['export__col-setting']} />
      </colgroup>
      <thead>
        <tr>
          <th scope="col">Field</th>
          <th scope="col">Values</th>
          <th scope="col">Captured</th>
          <th scope="col">{afterHeading}</th>
          <th scope="col">Setting</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.path}>
            <th scope="row" className={styles['export__path']}>
              {row.path}
            </th>
            <td>{row.distinctValues}</td>
            <td className={styles['export__value']}>{valueCell(row.before)}</td>
            <td className={styles['export__value']}>{valueCell(row.after)}</td>
            <td>
              <select
                aria-label={`Setting for ${row.path}`}
                className={cn(styles['export__override'], 'input-2')}
                value={overrides[row.path] ?? AUTO}
                onChange={(event: ChangeEvent<HTMLSelectElement>): void => {
                  const next = event.target.value
                  if (!isOverrideChoice(next)) return
                  onOverride(row.path, next === AUTO ? null : next)
                }}
              >
                <option value={AUTO}>{autoLabel(row)}</option>
                <option value="verbatim">Always visible</option>
                <option value="pseudonymize">Always hidden</option>
              </select>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
)

/**
 * The export flow: what is being exported, how it will be redacted, what each
 * field becomes, and the download.
 *
 * @remarks
 * The `after` column is the pseudonymizer's **own output** — the same redacted
 * exchanges this panel hands to `emitHar`, so the archive cannot differ from
 * what was reviewed. The download is a same-origin blob; see `download-har.ts`.
 *
 * The preview is split by outcome rather than listed as one table. The rows
 * that need scrutiny are the ones leaving **as captured**; the pseudonymized
 * rows are the safe majority and would otherwise bury them.
 */
const ExportPanel = ({
  exchanges,
  sessionExchangeCount,
  sessionId,
  className,
}: ExportPanelProps): JSX.Element => {
  const {
    settings,
    preview,
    isBuilding,
    error,
    setEnumCarveOut,
    setEnumThreshold,
    setNamespaceUris,
    setOverride,
    download,
  } = useExport(exchanges, sessionId)
  const thresholdId = useId()
  const dropped = droppedBodyCount(exchanges)
  const withBodies = exchanges.length - dropped

  const visible = preview?.rows.filter((row) => row.verbatim) ?? []
  const hidden = preview?.rows.filter((row) => !row.verbatim) ?? []

  return (
    <section className={cn(styles['export'], className)} aria-label="Export">
      <section aria-label="What this export contains">
        <h3 className={cn(styles['export__section-title'], 'text-label-3')}>
          What this export contains
        </h3>
        <ul className={cn(styles['export__manifest'], 'text-body-3')}>
          <li>
            <strong>
              {exchanges.length === sessionExchangeCount
                ? `All ${sessionExchangeCount} exchanges`
                : `${exchanges.length} of ${sessionExchangeCount} exchanges`}
            </strong>
            {exchanges.length === sessionExchangeCount
              ? ' in this recording.'
              : ' — the ones the current filters show.'}
          </li>
          <li>
            Each one&rsquo;s <strong>URL, response status, response headers, and timings</strong>.
          </li>
          <li>
            {withBodies === 0
              ? 'No response bodies — none of these exchanges carry a JSON body.'
              : `${withBodies === 1 ? '1 JSON response body' : `${withBodies} JSON response bodies`}.`}
          </li>
        </ul>

        <h3 className={cn(styles['export__section-title'], 'text-label-3')}>
          What it does not contain
        </h3>
        <ul className={cn(styles['export__manifest'], 'text-body-3')}>
          <li>
            <strong>No request method, request headers, or request body</strong> — the capture never
            observed them, so this archive cannot tell a GET from a POST.
          </li>
          <li>
            {dropped === 0
              ? 'No non-JSON bodies to drop.'
              : `${dropped === 1 ? '1 non-JSON body' : `${dropped} non-JSON bodies`} — dropped at the redaction boundary, since a format the redactor cannot parse cannot be pseudonymized. Their sizes and content types are kept; their content is not.`}
          </li>
          <li>
            <strong>No original values</strong>, except at the fields marked visible below.
          </li>
        </ul>
        <p className={cn(styles['export__note'], 'text-body-3')}>
          Pseudonyms are stable within this archive, so identifiers still join across endpoints, and
          independent across exports, so two archives of one recording cannot be linked. The file is
          saved from this page — nothing is uploaded.
        </p>
      </section>

      <div className={styles['export__settings']}>
        <ToggleSwitch
          checked={settings.enumCarveOut}
          label="Show short codes as captured (status, units)"
          onChange={setEnumCarveOut}
        />
        <Field label="Up to this many values" htmlFor={thresholdId}>
          <input
            id={thresholdId}
            type="number"
            min={0}
            className={cn(styles['export__threshold'], 'input-2')}
            value={settings.enumThreshold}
            disabled={!settings.enumCarveOut}
            onChange={(event: ChangeEvent<HTMLInputElement>): void => {
              const next = Number(event.target.value)
              if (Number.isInteger(next) && next >= 0) setEnumThreshold(next)
            }}
          />
        </Field>
        <ToggleSwitch
          checked={settings.namespaceUris}
          label="Show schema URLs as captured (system, extension url)"
          onChange={setNamespaceUris}
        />
      </div>

      <ErrorBanner error={error} />

      {isBuilding ? <PageLoading message="Building the redaction preview…" /> : null}

      {preview === null ? null : (
        <>
          <section aria-label="Fields exported as captured">
            <h3 className={cn(styles['export__section-title'], 'text-label-3')}>
              {visible.length === 0
                ? 'No fields are exported as captured'
                : `Exported as captured — read these (${visible.length})`}
            </h3>
            {visible.length === 0 ? (
              <p className={cn(styles['export__note'], 'text-body-3')}>
                Every value in this export is replaced with a pseudonym. Turn on
                <em> Show short codes as captured</em> if you need status and unit codes readable,
                or
                <em> Show schema URLs as captured</em> to keep the URLs that name what a code or an
                extension means.
              </p>
            ) : (
              <>
                <p className={cn(styles['export__note'], 'text-body-3')}>
                  <StatusBadge tone="warning">
                    These values leave this device exactly as recorded
                  </StatusBadge>
                </p>
                <PreviewTable
                  rows={visible}
                  overrides={settings.overrides}
                  onOverride={setOverride}
                  afterHeading="Exported"
                />
              </>
            )}
          </section>

          <details className={styles['export__details']}>
            <summary className={cn(styles['export__summary'], 'text-label-3')}>
              {`Replaced with pseudonyms (${hidden.length})`}
            </summary>
            <p className={cn(styles['export__note'], 'text-body-3')}>
              A field is hidden when it is neither a short code nor a schema URL, when it takes more
              values than the threshold, or when the matching switch is off. Open one to reveal it.
            </p>
            {hidden.length === 0 ? (
              <p className={cn(styles['export__note'], 'text-body-3')}>Nothing is pseudonymized.</p>
            ) : (
              <PreviewTable
                rows={hidden}
                overrides={settings.overrides}
                onOverride={setOverride}
                afterHeading="Exported as"
              />
            )}
          </details>

          <div className={styles['export__actions']}>
            <button type="button" className="button-2" onClick={download}>
              Download redacted HAR
            </button>
          </div>
        </>
      )}
    </section>
  )
}

export { ExportPanel, type ExportPanelProps }
