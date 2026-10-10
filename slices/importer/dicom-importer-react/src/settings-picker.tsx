import type { DicomSettings } from 'dicom-importer-core'
import { DateTime, Option } from 'effect'
import type { SettingsPickerProps } from 'importer-fundamentals'
import { type JSX, useId, useState } from 'react'
import { useDebouncedCallback } from 'react-kitchen-sink'

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
 * Two things the field does beyond mirroring `settings.timeZone`:
 *
 * - It reports up on a {@link COMMIT_DELAY_MS} debounce, flushed on blur or
 *   Enter, because each report re-decodes the whole batch.
 * - It reports only a zone the runtime can resolve. Every half-typed prefix of
 *   `America/Toronto` is itself a name the runtime rejects, and committing
 *   those would flip each file to "could not be read" and back on the way
 *   through. An unresolvable name is flagged inline (`aria-invalid`, a
 *   message) instead, and the decode carries on under the last zone that did
 *   resolve.
 *
 * Between commits the draft is the field's own: it seeds from
 * `settings.timeZone` on mount and is not re-seeded, so a commit echoing back
 * as a prop cannot clobber keystrokes typed since it went out. A caller that
 * needs to reset the field to a new zone remounts it with a React `key` — the
 * idiom for exactly this, and the one place the behaviour is visible.
 */
const DicomSettingsPicker = ({
  settings,
  onChange,
}: SettingsPickerProps<DicomSettings>): JSX.Element => {
  const inputId = useId()
  const listId = useId()
  const messageId = useId()

  const [draft, setDraft] = useState(settings.timeZone)
  const commit = useDebouncedCallback((timeZone: string) => {
    onChange({ ...settings, timeZone })
  }, COMMIT_DELAY_MS)

  const edit = (timeZone: string): void => {
    setDraft(timeZone)
    // Cancel rather than leave an earlier valid prefix scheduled: typing on
    // past `UTC` into `UTC-nonsense` must not commit `UTC` a beat later.
    if (isKnownTimeZone(timeZone)) commit.call(timeZone)
    else commit.cancel()
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
        onChange={(event) => edit(event.target.value)}
        onBlur={commit.flush}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit.flush()
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
