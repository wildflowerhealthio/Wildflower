import { DateTime, Option } from 'effect'
import type { SettingsPickerProps } from 'har-importer-react'
import type { LifeLabsPdfSettings } from 'lifelabs-pdf-importer-core'
import { type JSX, useId } from 'react'

const SUGGESTED_TIME_ZONES = ['America/Toronto', 'America/Vancouver'] as const

const UNKNOWN_ZONE_MESSAGE = 'Not an IANA time zone name (for example America/Toronto).'

const isKnownTimeZone = (timeZone: string): boolean =>
  Option.isSome(DateTime.zoneMakeNamed(timeZone))

/**
 * The LifeLabs PDF format's settings picker: the one knob the format has, the
 * IANA time zone the report's printed clock is in.
 *
 * @remarks
 * A free-text field with the two LifeLabs provinces' zones suggested through a
 * `datalist`, so any zone can be typed and the common ones need no typing.
 * Every change is reported up through {@link SettingsPickerProps.onChange}
 * verbatim — the shell owns the settings — and a name the runtime does not
 * know is flagged inline (`aria-invalid`, a message) rather than swallowed,
 * since the import's parse fails on it.
 */
const LifeLabsPdfSettingsPicker = ({
  settings,
  onChange,
}: SettingsPickerProps<LifeLabsPdfSettings>): JSX.Element => {
  const inputId = useId()
  const listId = useId()
  const messageId = useId()
  const known = isKnownTimeZone(settings.timeZone)
  return (
    <div>
      <label htmlFor={inputId}>Report time zone</label>
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

export { LifeLabsPdfSettingsPicker, SUGGESTED_TIME_ZONES, UNKNOWN_ZONE_MESSAGE }
