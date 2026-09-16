import { type DicomSettings, runtimeTimeZone } from 'dicom-importer-core'
import { DateTime, Option } from 'effect'
import type { SettingsPickerProps } from 'importer-fundamentals'
import { type JSX, useId } from 'react'

const UNKNOWN_ZONE_MESSAGE = 'Not an IANA time zone name (for example America/Toronto).'

/**
 * The zones offered without typing: this runtime's own zone first — a study is
 * usually imported near where it was acquired — then `UTC`, for a file whose
 * equipment was set to it. Any other zone can still be typed.
 */
const SUGGESTED_TIME_ZONES: readonly string[] = [...new Set([runtimeTimeZone(), 'UTC'])]

const isKnownTimeZone = (timeZone: string): boolean =>
  Option.isSome(DateTime.zoneMakeNamed(timeZone))

/**
 * The DICOM format's settings picker: the one knob the format has, the IANA
 * time zone the acquiring equipment's clock was set to.
 *
 * @remarks
 * A free-text field with the likely zones suggested through a `datalist`, so
 * any zone can be typed and the common ones need no typing. Every change is
 * reported up through {@link SettingsPickerProps.onChange} verbatim — the
 * shell owns the settings — and a name the runtime does not know is flagged
 * inline (`aria-invalid`, a message) rather than swallowed, since
 * `decodeDicom` fails on it.
 */
const DicomSettingsPicker = ({
  settings,
  onChange,
}: SettingsPickerProps<DicomSettings>): JSX.Element => {
  const inputId = useId()
  const listId = useId()
  const messageId = useId()
  const known = isKnownTimeZone(settings.timeZone)
  return (
    <div>
      <label htmlFor={inputId}>Equipment time zone</label>
      <input
        id={inputId}
        type="text"
        list={listId}
        value={settings.timeZone}
        aria-invalid={!known}
        aria-describedby={known ? undefined : messageId}
        onChange={(event) => onChange({ ...settings, timeZone: event.target.value })}
      />
      <datalist id={listId}>
        {SUGGESTED_TIME_ZONES.map((zone) => (
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

export { DicomSettingsPicker, SUGGESTED_TIME_ZONES, UNKNOWN_ZONE_MESSAGE }
