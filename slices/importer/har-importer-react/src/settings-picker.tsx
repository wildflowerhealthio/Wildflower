import type { JSX } from 'react'

import type { HarSettings } from 'har-importer-core'

/**
 * The props a format's settings picker receives — the current settings and a way
 * to change them. Generic over the format's `TSettings` so each picker is
 * written against its own precise shape, mirroring the collector slice's
 * `ConfigFormProps`.
 */
interface SettingsPickerProps<TSettings> {
  /** The current settings value. */
  readonly settings: TSettings
  /** Called with the next settings when the user changes them. */
  readonly onChange: (settings: TSettings) => void
}

/**
 * The HAR format's settings picker — a no-op today.
 *
 * @remarks
 * A HAR archive is decoded and recognized with no user-tunable knobs, so this
 * renders only a hint and never calls {@link SettingsPickerProps.onChange}. It
 * exists so the shell's `format → { descriptor, SettingsPicker, ReviewBody }`
 * registry has all three parts for HAR — the seam a format with real settings
 * (a redaction toggle, a root allowlist) fills in without the shell learning a
 * new shape.
 */
const HarSettingsPicker = (_props: SettingsPickerProps<HarSettings>): JSX.Element => (
  <p>No import settings for a HAR archive.</p>
)

export { HarSettingsPicker }
export type { SettingsPickerProps }
