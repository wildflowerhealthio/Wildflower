import { useCallback, useState } from 'react'

/**
 * A locally-editable draft over a canonical source, with dirty tracking, a
 * partial-update view, and per-field 3-way rebase — the reusable shape behind a
 * settings form that edits server-owned state.
 */
export interface FieldDraft<K extends string> {
  /** Current draft values — bind these to inputs. */
  readonly fields: Record<K, string>
  /** Set one field from a controlled-input change. */
  readonly setField: (key: K, value: string) => void
  /** Whether any field differs from its current baseline (per `equals`). */
  readonly dirty: boolean
  /** The changed fields and their draft values — the partial update to send. */
  readonly changes: Partial<Record<K, string>>
  /** Discard local edits, snapping every field back to the current baseline. */
  readonly reset: () => void
}

/**
 * A draft of string `fields` reconciled to a canonical `baseline` by a per-field
 * 3-way merge. Three values per field: the baseline last synced to, the current
 * `baseline`, and the local draft. On every render a field the baseline
 * *changed* (current ≠ last-synced) is adopted into the draft — the rebase a
 * fresh upstream value demands — while a field it left alone keeps the user's
 * edit. So an unsaved edit survives an unrelated upstream update, and a genuine
 * upstream change rebases over it. (React's documented "adjust state on prop
 * change during render" idiom, in one place.)
 *
 * `equals(draftValue, baselineValue)` decides *dirtiness* (default `Object.is`);
 * pass a normalizing comparison — e.g. trim-aware — to ignore incidental
 * whitespace. A **write-only** field, one the upstream never echoes back, is
 * modelled by a baseline that's always `''`: it reads dirty whenever non-empty
 * and, because its last-synced and current baselines are both `''`, a rebase
 * never clobbers the typed value.
 *
 * `baseline` is read by field, so a new object identity each render is fine —
 * only the per-field string values matter.
 */
export const useFieldDraft = <K extends string>(
  keys: readonly K[],
  baseline: Record<K, string>,
  equals: (draftValue: string, baselineValue: string) => boolean = Object.is
): FieldDraft<K> => {
  const [synced, setSynced] = useState(baseline)
  const [fields, setFields] = useState(baseline)

  // 3-way rebase: adopt only the fields whose baseline itself changed, so a
  // field the upstream left alone keeps the user's in-progress edit.
  const rebased = keys.filter((key) => !Object.is(synced[key], baseline[key]))
  if (rebased.length > 0) {
    setSynced(baseline)
    setFields((local) =>
      rebased.reduce<Record<K, string>>((next, key) => ({ ...next, [key]: baseline[key] }), local)
    )
  }

  const setField = useCallback((key: K, value: string): void => {
    setFields((local) => ({ ...local, [key]: value }))
  }, [])

  const reset = (): void => {
    setSynced(baseline)
    setFields(baseline)
  }

  const changes: Partial<Record<K, string>> = {}
  for (const key of keys) {
    if (!equals(fields[key], baseline[key])) changes[key] = fields[key]
  }

  return { fields, setField, changes, dirty: Object.keys(changes).length > 0, reset }
}
