import type { JSX } from 'react'

import { fhirSources, type HarSettings } from 'har-importer-core'
import type { SettingsPickerProps } from 'importer-fundamentals'

/**
 * The HAR format's settings picker: whole-import include toggles for the
 * registered response kinds, grouped by source.
 *
 * @remarks
 * The one knob the format has. The toggles drive
 * {@link HarSettings.disabledKinds} — a pre-decode setting, so the shell
 * re-decodes the batch's HAR files when one changes and the review shows
 * exactly what the surviving kinds parse. Kinds default to on; the settings
 * hold only the explicit opt-outs.
 *
 * @packageDocumentation
 */

/**
 * The display label for a kind: its `name` without the conventional
 * `ResponseKind` suffix every kind's identity carries.
 */
const kindLabel = (name: string): string => name.replace(/ResponseKind$/, '')

/** Toggle one kind name in/out of the disabled list, preserving the others. */
const toggleKind = (settings: HarSettings, kindName: string): HarSettings => {
  const disabled = settings.disabledKinds.includes(kindName)
  return {
    ...settings,
    disabledKinds: disabled
      ? settings.disabledKinds.filter((name) => name !== kindName)
      : [...settings.disabledKinds, kindName],
  }
}

/** The interactive kind toggles over the HAR sources. */
const HarSettingsPicker = ({
  settings,
  onChange,
}: SettingsPickerProps<HarSettings>): JSX.Element => (
  <fieldset>
    <legend>Include</legend>
    {fhirSources.map((source) => (
      <div key={source.name} role="group" aria-label={source.display.title}>
        <p>{source.display.title}</p>
        <p>{source.display.description}</p>
        {source.responseKinds.map((kind) => (
          <label key={kind.name}>
            <input
              type="checkbox"
              checked={!settings.disabledKinds.includes(kind.name)}
              onChange={() => onChange(toggleKind(settings, kind.name))}
            />
            {kindLabel(kind.name)}
          </label>
        ))}
      </div>
    ))}
  </fieldset>
)

export { HarSettingsPicker }
