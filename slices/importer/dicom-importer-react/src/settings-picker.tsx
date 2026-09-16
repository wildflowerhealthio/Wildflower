import type { DicomSettings } from 'dicom-importer-core'
import { DateTime, Option } from 'effect'
import type { SettingsPickerProps } from 'importer-fundamentals'
import { type JSX, useEffect, useId, useRef, useState } from 'react'

import { suggestedTimeZones } from './time-zones.ts'

const UNKNOWN_ZONE_MESSAGE =
  'Not an IANA time zone name (for example America/Toronto). The import keeps using the last recognized zone.'

/**
 * How long the field waits after the last keystroke before reporting a zone up.
 *
 * @remarks
 * A committed zone re-decodes every DICOM file in the batch and re-runs the
 * server comparison, so reporting each keystroke would run that whole round
 * trip a dozen times for one typed zone name. Long enough to cover normal
 * typing, short enough that a reviewer who pauses sees the preview follow.
 */
const COMMIT_DELAY_MS = 400

const isKnownTimeZone = (timeZone: string): boolean =>
  Option.isSome(DateTime.zoneMakeNamed(timeZone))

const ZONE_OPTIONS = suggestedTimeZones()

/**
 * The DICOM format's settings picker: the one knob the format has, the IANA
 * time zone the acquiring equipment's clock was set to.
 *
 * @remarks
 * A free-text field with the likely zones offered through a `datalist`, so the
 * common ones need no typing and any other IANA name can still be typed.
 *
 * The field holds the reviewer's keystrokes locally and reports up on a
 * {@link COMMIT_DELAY_MS} debounce (flushed immediately on blur or Enter),
 * because each report re-decodes the whole batch. It reports only a zone the
 * runtime can resolve: every half-typed prefix of `America/Toronto` is itself
 * a name the runtime rejects, and committing those would flip each file to
 * "could not be read" and back on the way through. An unresolvable name is
 * flagged inline (`aria-invalid`, a message) instead, and the decode carries
 * on under the last zone that did resolve.
 */
const DicomSettingsPicker = ({
  settings,
  onChange,
}: SettingsPickerProps<DicomSettings>): JSX.Element => {
  const inputId = useId()
  const listId = useId()
  const messageId = useId()

  const [draft, setDraft] = useState(settings.timeZone)

  // Mirror the committed setting alongside the last zone this field sent up, so
  // an externally-changed setting (a reset) re-seeds the draft while this
  // field's own commit echoing back does not clobber keystrokes typed since it
  // went out. Adjusted during render off the changed prop — state rather than a
  // ref, since the decision is read while rendering.
  const [mirror, setMirror] = useState<{
    readonly committed: string
    readonly emitted: string | undefined
  }>({ committed: settings.timeZone, emitted: undefined })
  if (settings.timeZone !== mirror.committed) {
    const ownEcho = settings.timeZone === mirror.emitted
    setMirror({ committed: settings.timeZone, emitted: mirror.emitted })
    if (!ownEcho) setDraft(settings.timeZone)
  }

  // The commit, behind a ref: `onChange` is a fresh closure on every parent
  // render, and depending on it directly would restart the debounce timer each
  // time the parent re-renders rather than each time the reviewer types.
  const commit = useRef<(zone: string) => void>(() => undefined)
  useEffect(() => {
    commit.current = (zone: string): void => {
      setMirror((previous) => ({ ...previous, emitted: zone }))
      onChange({ ...settings, timeZone: zone })
    }
  })

  const ready = draft !== mirror.committed && isKnownTimeZone(draft)
  useEffect(() => {
    const timer = ready ? setTimeout(() => commit.current(draft), COMMIT_DELAY_MS) : undefined
    return (): void => {
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [ready, draft])

  const flush = (): void => {
    if (ready) commit.current(draft)
  }

  const known = isKnownTimeZone(draft)
  return (
    <div>
      <label htmlFor={inputId}>Equipment time zone</label>
      <input
        id={inputId}
        type="text"
        list={listId}
        value={draft}
        aria-invalid={!known}
        aria-describedby={known ? undefined : messageId}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={flush}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            flush()
          }
        }}
      />
      <datalist id={listId}>
        {ZONE_OPTIONS.map((zone) => (
          <option key={zone} value={zone} />
        ))}
      </datalist>
      {known ? null : (
        <p id={messageId} role="alert">
          {UNKNOWN_ZONE_MESSAGE}
        </p>
      )}
    </div>
  )
}

export { COMMIT_DELAY_MS, DicomSettingsPicker, UNKNOWN_ZONE_MESSAGE }
