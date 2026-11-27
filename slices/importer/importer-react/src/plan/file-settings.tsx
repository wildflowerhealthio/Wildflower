import type { FormatKind, FormatSettings } from '@wildflowerhealthio/importer-core'
import { Option } from 'effect'
import { type JSX, useState } from 'react'

import { type FormatSettingsPicker, formatRegistry } from '../registry.ts'
import { SETTINGS_LABEL, settingsSummaryLine } from './plan-text.ts'
import styles from './file-settings.module.css'

/** What {@link FileSettings} shows and does. */
interface FileSettingsProps<K extends FormatKind> {
  /** The format whose settings these are. */
  readonly format: K
  /** Every format's settings as the reviewer last set them. */
  readonly settings: FormatSettings
  /** How many file sets of the format the import holds: the settings are each one's. */
  readonly formatFileSets: number
  readonly onApplySettings: (format: K, formatSettings: FormatSettings[K]) => void
}

/**
 * A format's settings slot as one shape whatever the format: the slot is
 * conditional on the format's settings type, which stays deferred under a
 * generic format, so its picker could not be rendered as it is.
 */
interface FormatSettingsSlot<K extends FormatKind> {
  readonly SettingsPicker?: FormatSettingsPicker<K>
  readonly settingsLineOf?: (settings: FormatSettings[K]) => string
}

/**
 * The key a picker is mounted under: a new one whenever the format's
 * settings change other than by this picker, so a picker that holds a
 * draft of its own (DICOM's) shows a change another section's picker made,
 * while the picker being typed in keeps its element, its focus and its
 * draft.
 */
const usePickerGeneration = <TSettings,>(
  formatSettings: TSettings
): { readonly generation: number; readonly handleReported: (reported: TSettings) => void } => {
  const [reported, setReported] = useState<Option.Option<TSettings>>(Option.none())
  const [shown, setShown] = useState({ formatSettings, generation: 0 })
  if (shown.formatSettings !== formatSettings) {
    setShown({
      formatSettings,
      generation: Option.exists(reported, (sent) => sent === formatSettings)
        ? shown.generation
        : shown.generation + 1,
    })
  }
  return {
    generation: shown.generation,
    handleReported: (next) => setReported(Option.some(next)),
  }
}

/**
 * A file's Settings, at the end of its section: a `<details>` whose summary
 * reads "Settings" and what they say on one line, which says too that they
 * are every file's of the format when the format brings several file sets;
 * its panel holds the format's registered settings picker, which applies a
 * change through `onApplySettings`. Nothing for a format with no settings.
 * The summary says the settings as the reviewer set them; whether the plan
 * shown was read under them is said once, above the import bar.
 *
 * @remarks
 * Whether the details are open is the element's own state, so it survives
 * the plan read again while its section stays mounted.
 */
const FileSettings = <K extends FormatKind>({
  format,
  settings,
  formatFileSets,
  onApplySettings,
}: FileSettingsProps<K>): JSX.Element | null => {
  const formatSettings = settings[format]
  const { generation, handleReported } = usePickerGeneration(formatSettings)
  const slot: FormatSettingsSlot<K> = formatRegistry[format]
  const { SettingsPicker: Picker, settingsLineOf } = slot
  if (Picker === undefined || settingsLineOf === undefined) return null
  const handleChange = (next: FormatSettings[K]): void => {
    handleReported(next)
    onApplySettings(format, next)
  }
  return (
    <details className={styles['file-settings']}>
      <summary className={styles['file-settings__summary']}>
        <span>{SETTINGS_LABEL}</span>
        <span className={styles['file-settings__line']}>
          {settingsSummaryLine({
            statement: settingsLineOf(formatSettings),
            formatTitle: formatRegistry[format].display.title,
            formatFileSets,
          })}
        </span>
      </summary>
      <div className={styles['file-settings__panel']}>
        <Picker key={generation} settings={formatSettings} onChange={handleChange} />
      </div>
    </details>
  )
}

export { FileSettings }
export type { FileSettingsProps }
