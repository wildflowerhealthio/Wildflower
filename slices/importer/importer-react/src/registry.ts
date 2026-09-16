import { DicomSettingsPicker } from 'dicom-importer-react'
import { HarSettingsPicker } from 'har-importer-react'
import {
  type BoundFormat as CoreBoundFormat,
  defaultFormatSettings,
  type FormatKind,
  formatKinds,
  formatRegistry as coreRegistry,
  type FormatSettings,
  type FormatVariant,
} from 'importer-core'
import type { SettingsPickerProps } from 'importer-fundamentals'
import { LifeLabsPdfSettingsPicker } from 'lifelabs-pdf-importer-react'
import type { JSX } from 'react'

/**
 * The shell's view of the closed format registry: `importer-core`'s
 * descriptor registry with the one React part a format contributes — its
 * `SettingsPicker` — layered on each entry. The single edit point for wiring
 * a format's UI into the shell; the descriptor half is registered in
 * `importer-core`.
 *
 * @remarks
 * `BoundFormat<K>` keeps per-format concrete types through
 * {@link FormatVariant}, so a picker typed against another format's settings
 * fails to compile here. The review display is not a registry slot: every
 * format is reviewed through the shell's one generalized sectioned view.
 *
 * @packageDocumentation
 */

/** One registered format: its descriptor plus its settings picker, typed per {@link FormatKind}. */
type BoundFormat<K extends FormatKind> = CoreBoundFormat<K> & {
  readonly SettingsPicker: (props: SettingsPickerProps<FormatVariant[K]['settings']>) => JSX.Element
}

/** The closed registry; its keys are the {@link FormatKind} union. */
const formatRegistry: { readonly [K in FormatKind]: BoundFormat<K> } = {
  har: { ...coreRegistry.har, SettingsPicker: HarSettingsPicker },
  'lifelabs-pdf': { ...coreRegistry['lifelabs-pdf'], SettingsPicker: LifeLabsPdfSettingsPicker },
  dicom: { ...coreRegistry.dicom, SettingsPicker: DicomSettingsPicker },
}

export { defaultFormatSettings, formatKinds, formatRegistry }
export type { BoundFormat, FormatKind, FormatSettings, FormatVariant }
