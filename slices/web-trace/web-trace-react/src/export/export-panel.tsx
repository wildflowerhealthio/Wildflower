import { useId, type ChangeEvent, type JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { Chip, ErrorBanner, Field, PageLoading, StatusBadge, ToggleSwitch } from 'react-tundraish'
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

/** How a row's decision reads: what happens, and what decided it. */
const describeDecision = (row: PreviewRow): string => {
  if (row.decidedBy === 'override')
    return row.verbatim ? 'revealed (override)' : 'hidden (override)'
  if (row.verbatim) return `revealed (≤ threshold)`
  return row.decidedBy === 'disabled' ? 'hidden (carve-out off)' : 'hidden (> threshold)'
}

/** Whether a string is one of the values the override select can produce. */
const isOverrideChoice = (value: string): value is PathOverride | typeof AUTO =>
  value === AUTO || value === 'verbatim' || value === 'pseudonymize'

/**
 * The export flow: what is being exported, how it will be redacted, what each
 * path becomes, and the download.
 *
 * @remarks
 * The `after` column is the pseudonymizer's **own output** — the same redacted
 * exchanges this panel hands to `emitHar`, so the archive cannot differ from
 * what was reviewed. The download is a same-origin blob; see `download-har.ts`.
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
    setOverride,
    download,
  } = useExport(exchanges, sessionId)
  const thresholdId = useId()
  const dropped = droppedBodyCount(exchanges)

  return (
    <section className={cn(styles['export'], className)} aria-label="Export">
      <div>
        <p className={cn(styles['export__note'], 'text-body-2')}>
          {exchanges.length === sessionExchangeCount
            ? `Exporting all ${sessionExchangeCount} exchanges in this recording.`
            : `Exporting ${exchanges.length} of ${sessionExchangeCount} exchanges — the current filters.`}
        </p>
        <p className={cn(styles['export__note'], 'text-body-3')}>
          Values leave this device only in the archive you download, and only as pseudonyms unless a
          path below says otherwise. Pseudonyms are stable within this archive so identifiers still
          join across endpoints, and independent across exports so two archives of one recording
          cannot be linked.
        </p>
        {dropped > 0 ? (
          <p className={cn(styles['export__note'], 'text-body-3')}>
            <StatusBadge tone="warning">
              {dropped === 1
                ? '1 non-JSON body is dropped at the boundary — its size and reason are kept, its content is not'
                : `${dropped} non-JSON bodies are dropped at the boundary — their sizes and reasons are kept, their content is not`}
            </StatusBadge>
          </p>
        ) : null}
      </div>

      <div className={styles['export__settings']}>
        <ToggleSwitch
          checked={settings.enumCarveOut}
          label="Export low-cardinality paths verbatim"
          onChange={setEnumCarveOut}
        />
        <Field label="Threshold (N)" htmlFor={thresholdId}>
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
      </div>

      <ErrorBanner error={error} />

      {isBuilding ? <PageLoading message="Building the redaction preview…" /> : null}

      {preview === null ? null : (
        <>
          <section aria-label="Redaction preview">
            <h3 className={cn(styles['export__section-title'], 'text-label-3')}>
              {`Redaction preview (${preview.rows.length} paths)`}
            </h3>
            {preview.rows.length === 0 ? (
              <p className={cn(styles['export__note'], 'text-body-3')}>
                These exchanges carry no values to redact.
              </p>
            ) : (
              <div className={styles['export__table-scroll']}>
                <table className={cn(styles['export__table'], 'text-body-3')}>
                  <thead>
                    <tr>
                      <th scope="col">Path</th>
                      <th scope="col">Distinct</th>
                      <th scope="col">Before</th>
                      <th scope="col">After</th>
                      <th scope="col">Decision</th>
                      <th scope="col">Override</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((row) => (
                      <tr key={row.path}>
                        <th scope="row" className={styles['export__path']}>
                          {row.path}
                        </th>
                        <td>{row.distinctValues}</td>
                        <td className={styles['export__value']}>{valueCell(row.before)}</td>
                        <td className={styles['export__value']}>{valueCell(row.after)}</td>
                        <td>
                          <Chip>{describeDecision(row)}</Chip>
                        </td>
                        <td>
                          <select
                            aria-label={`Override for ${row.path}`}
                            className={cn(styles['export__override'], 'input-2')}
                            value={settings.overrides[row.path] ?? AUTO}
                            onChange={(event: ChangeEvent<HTMLSelectElement>): void => {
                              const next = event.target.value
                              if (!isOverrideChoice(next)) return
                              setOverride(row.path, next === AUTO ? null : next)
                            }}
                          >
                            <option value={AUTO}>Auto</option>
                            <option value="verbatim">Reveal</option>
                            <option value="pseudonymize">Hide</option>
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <div className={styles['export__actions']}>
            <button type="button" className="button-2" onClick={download}>
              Download redacted HAR
            </button>
            <span className={cn(styles['export__note'], 'text-body-3')}>
              Saved from this page. Nothing is uploaded.
            </span>
          </div>
        </>
      )}
    </section>
  )
}

export { ExportPanel, type ExportPanelProps }
