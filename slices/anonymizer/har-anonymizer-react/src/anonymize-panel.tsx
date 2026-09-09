import type { PathOverride } from 'har-anonymizer-core'
import type { HttpArchive } from 'har-importer-core/har'
import { useId, type ChangeEvent, type JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { ErrorBanner, Field, PageLoading, StatusBadge, ToggleSwitch } from 'react-tundraish'

import { droppedBodyCount, jsonBodyCount, type PreviewRow } from './redaction-preview.ts'
import { useAnonymize } from './use-anonymize.ts'
import styles from './anonymize-panel.module.css'

/** The `<option>` value standing for "no override — use the policy's own decision". */
const AUTO = 'auto'

/** Props for {@link AnonymizePanel}. */
interface AnonymizePanelProps {
  /**
   * The archive being anonymized, parsed once by the caller — normally an
   * `HttpArchive.LogFromHarJson` decode of a `.har` the user picked.
   *
   * @remarks
   * Must be a **stable** reference across renders (memoise it in the parent),
   * since its identity is what triggers a rebuild of the preview.
   */
  readonly log: HttpArchive.Log
  /**
   * The name of the file the user picked. Used to derive the output name —
   * `<original-stem>.anonymized.har`.
   */
  readonly fileName: string
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
  <div className={styles['anonymize__table-scroll']}>
    <table className={cn(styles['anonymize__table'], 'text-body-3')}>
      <colgroup>
        <col className={styles['anonymize__col-path']} />
        <col className={styles['anonymize__col-count']} />
        <col className={styles['anonymize__col-value']} />
        <col className={styles['anonymize__col-value']} />
        <col className={styles['anonymize__col-setting']} />
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
            <th scope="row" className={styles['anonymize__path']}>
              {row.path}
            </th>
            <td>{row.distinctValues}</td>
            <td className={styles['anonymize__value']}>{valueCell(row.before)}</td>
            <td className={styles['anonymize__value']}>{valueCell(row.after)}</td>
            <td>
              <select
                aria-label={`Setting for ${row.path}`}
                className={cn(styles['anonymize__override'], 'input-2')}
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
 * The anonymize flow: what is being anonymized, how it will be redacted, what
 * each field becomes, and the download.
 *
 * @remarks
 * The `after` column is the pseudonymizer's **own output** — the same redacted
 * archive this panel hands to `emitHarFromLog`, so the archive cannot differ
 * from what was reviewed. The download is a same-origin blob; see
 * `download-har.ts`.
 *
 * The preview is split by outcome rather than listed as one table. The rows
 * that need scrutiny are the ones leaving **as captured**; the pseudonymized
 * rows are the safe majority and would otherwise bury them.
 */
const AnonymizePanel = ({ log, fileName, className }: AnonymizePanelProps): JSX.Element => {
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
  } = useAnonymize(log, fileName)
  const thresholdId = useId()
  const withBodies = jsonBodyCount(log)
  const dropped = droppedBodyCount(log)

  const visible = preview?.rows.filter((row) => row.verbatim) ?? []
  const hidden = preview?.rows.filter((row) => !row.verbatim) ?? []

  return (
    <section className={cn(styles['anonymize'], className)} aria-label="Anonymize">
      <section aria-label="What this archive contains">
        <h3 className={cn(styles['anonymize__section-title'], 'text-label-3')}>
          What this archive contains
        </h3>
        <ul className={cn(styles['anonymize__manifest'], 'text-body-3')}>
          <li>
            <strong>
              {log.entries.length === 1
                ? '1 archived response'
                : `${log.entries.length} archived responses`}
            </strong>
            {' from the source archive.'}
          </li>
          <li>
            Each one&rsquo;s <strong>URL, response status, response headers</strong>.
          </li>
          <li>
            {withBodies === 0
              ? 'No response bodies — none of these responses carry a JSON body.'
              : `${withBodies === 1 ? '1 JSON response body' : `${withBodies} JSON response bodies`}.`}
          </li>
        </ul>

        <h3 className={cn(styles['anonymize__section-title'], 'text-label-3')}>
          What it does not contain
        </h3>
        <ul className={cn(styles['anonymize__manifest'], 'text-body-3')}>
          <li>
            <strong>Request method, request headers and request body were dropped</strong> at import
            — the projection carries the response half only, so this archive cannot tell a GET from
            a POST.
          </li>
          <li>
            {dropped === 0
              ? 'No non-JSON bodies to drop.'
              : `${dropped === 1 ? '1 non-JSON body' : `${dropped} non-JSON bodies`} — dropped at the redaction boundary, since a format the redactor cannot parse cannot be pseudonymized.`}
          </li>
          <li>
            <strong>No original values</strong>, except at the fields marked visible below.
          </li>
        </ul>
        <p className={cn(styles['anonymize__note'], 'text-body-3')}>
          Pseudonyms are stable within this archive, so identifiers still join across endpoints, and
          independent across anonymized files, so two of one source cannot be linked. The file is
          saved from this page — nothing is uploaded.
        </p>
      </section>

      <div className={styles['anonymize__settings']}>
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
            className={cn(styles['anonymize__threshold'], 'input-2')}
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
            <h3 className={cn(styles['anonymize__section-title'], 'text-label-3')}>
              {visible.length === 0
                ? 'No fields are exported as captured'
                : `Exported as captured — read these (${visible.length})`}
            </h3>
            {visible.length === 0 ? (
              <p className={cn(styles['anonymize__note'], 'text-body-3')}>
                Every value in this archive is replaced with a pseudonym. Turn on
                <em> Show short codes as captured</em> if you need status and unit codes readable,
                or
                <em> Show schema URLs as captured</em> to keep the URLs that name what a code or an
                extension means.
              </p>
            ) : (
              <>
                <p className={cn(styles['anonymize__note'], 'text-body-3')}>
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

          <details className={styles['anonymize__details']}>
            <summary className={cn(styles['anonymize__summary'], 'text-label-3')}>
              {`Replaced with pseudonyms (${hidden.length})`}
            </summary>
            <p className={cn(styles['anonymize__note'], 'text-body-3')}>
              A field is hidden when it is neither a short code nor a schema URL, when it takes more
              values than the threshold, or when the matching switch is off. Open one to reveal it.
            </p>
            {hidden.length === 0 ? (
              <p className={cn(styles['anonymize__note'], 'text-body-3')}>
                Nothing is pseudonymized.
              </p>
            ) : (
              <PreviewTable
                rows={hidden}
                overrides={settings.overrides}
                onOverride={setOverride}
                afterHeading="Exported as"
              />
            )}
          </details>

          <div className={styles['anonymize__actions']}>
            <button type="button" className="button-2" onClick={download}>
              Download anonymized HAR
            </button>
          </div>
        </>
      )}
    </section>
  )
}

export { AnonymizePanel, type AnonymizePanelProps }
