import { Option } from 'effect'
import {
  diffJson,
  type DiffStatus,
  type FieldDiff,
  formatPath,
  formatSlot,
  normalizedEncode,
  resetFieldToServer,
  type ServerComparison,
} from 'fhir-r4/clients'
import type { FhirResource } from 'fhir-r4/resources'
import { type JSX, useState } from 'react'
import { Chip } from 'react-tundraish'

import { plural } from './preview-text.ts'
import styles from './diff-badge.module.css'

/**
 * The server-diff badge a previewed resource row carries, and the interactive
 * field-level disclosure behind it.
 *
 * @packageDocumentation
 */

/** User-visible label for each diff status. */
const DIFF_STATUS_LABEL: Record<DiffStatus, string> = {
  new: 'New',
  unchanged: 'Already on server',
  changed: 'Differs from server',
}

/**
 * The leaf diffs standing between the current (possibly edited) resource and
 * the server, recomputed against `current` — not the classify snapshot — so
 * the badge reflects exactly what a save would write: an edit to an otherwise
 * unchanged resource surfaces here, and a reset leaf drops out the instant it
 * matches again. Falls back to the snapshot `fields` when the current resource
 * cannot be re-encoded. `undefined` when the server holds no copy to diff
 * against (`new`, or an opaque `changed`).
 */
const liveFields = (
  comparison: ServerComparison,
  current: unknown
): readonly FieldDiff[] | undefined => {
  const server = comparison.server
  if (server === undefined) return undefined
  return Option.match(normalizedEncode(current), {
    onNone: () => comparison.fields,
    onSome: (value) => diffJson(server, value),
  })
}

/**
 * The interactive detail for a `changed` badge: one `path "server" -> "import"`
 * line per differing leaf, each with a "keep server value" button that resets
 * that one leaf on the incoming resource back to the server's.
 */
const DiffFieldList = ({
  fields,
  current,
  onKeepServerValue,
}: {
  readonly fields: readonly FieldDiff[]
  readonly current: unknown
  readonly onKeepServerValue: (resource: FhirResource) => void
}): JSX.Element => (
  <ul className={styles['diff-badge__field-list']} role="group" aria-label="Field differences">
    {fields.map((field) => {
      const path = formatPath(field.path)
      return (
        <li key={path} className={styles['diff-badge__field']}>
          <code className={styles['diff-badge__path']}>{path}</code>
          <span className={styles['diff-badge__server']}>{formatSlot(field.server)}</span>
          <span className={styles['diff-badge__arrow']} aria-hidden="true">
            →
          </span>
          <span className={styles['diff-badge__incoming']}>{formatSlot(field.incoming)}</span>
          <button
            type="button"
            className={styles['diff-badge__keep-server']}
            aria-label={`Keep the server value for ${path}`}
            onClick={() =>
              Option.match(resetFieldToServer(current, field), {
                onNone: () => undefined,
                onSome: onKeepServerValue,
              })
            }
          >
            Keep server value
          </button>
        </li>
      )
    })}
  </ul>
)

/**
 * Badge shown on a resource row from the server-diff pre-fetch, reflecting the
 * *current* (possibly edited) resource against the server:
 *
 * - `new` (no server copy) — a static "New" chip.
 * - a server copy the current resource matches — a static "Already on server"
 *   chip (whether it always matched, or an edit/reset just brought it back).
 * - a server copy the current resource differs from — an interactive
 *   disclosure: hover *or* click the badge to reveal each
 *   `field "server" -> "import"` line and its per-field reset. This is what
 *   surfaces an edit to an otherwise-unchanged resource, and updates live as
 *   the reviewer edits.
 *
 * Absent when the status is unknown (the pre-fetch is still in flight, or the
 * row's key is not in the map).
 */
const DiffBadge = ({
  comparison,
  current,
  onKeepServerValue,
}: {
  readonly comparison: ServerComparison | undefined
  readonly current: unknown
  readonly onKeepServerValue: (resource: FhirResource) => void
}): JSX.Element | null => {
  const [pinned, setPinned] = useState(false)
  const [hovered, setHovered] = useState(false)
  if (comparison === undefined) return null
  const fields = liveFields(comparison, current)
  // No server copy to diff against: report the classify-time status verbatim
  // (`new`, or an opaque `changed` whose server copy would not decode).
  if (fields === undefined) {
    const { status } = comparison
    return (
      <Chip
        className={styles[`diff-badge--${status}`] ?? styles['diff-badge']}
        data-diff-status={status}
        aria-label={DIFF_STATUS_LABEL[status]}
      >
        {DIFF_STATUS_LABEL[status]}
      </Chip>
    )
  }
  // A server copy exists and the current resource matches it.
  if (fields.length === 0) {
    return (
      <Chip
        className={styles['diff-badge--unchanged'] ?? styles['diff-badge']}
        data-diff-status="unchanged"
        aria-label={DIFF_STATUS_LABEL.unchanged}
      >
        {DIFF_STATUS_LABEL.unchanged}
      </Chip>
    )
  }
  const open = pinned || hovered
  const label = `${DIFF_STATUS_LABEL.changed}: ${fields.length} ${plural(fields.length, 'field')}`
  return (
    <span
      className={styles['diff-badge__container']}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        className={styles['diff-badge--changed'] ?? styles['diff-badge']}
        data-diff-status="changed"
        aria-expanded={open}
        aria-label={`${label}; show differences`}
        onClick={() => setPinned((previous) => !previous)}
      >
        {label}
      </button>
      {open && (
        <div className={styles['diff-badge__details']}>
          <DiffFieldList fields={fields} current={current} onKeepServerValue={onKeepServerValue} />
        </div>
      )}
    </span>
  )
}

export { DiffBadge }
