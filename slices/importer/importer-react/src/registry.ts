import { DicomSettingsPicker } from 'dicom-importer-react'
import { HarSettingsPicker } from 'har-importer-react'
import {
  defaultFormatSettings,
  type FormatKind,
  formatKinds,
  formatRegistry as coreRegistry,
  type FormatSettings,
  type FormatVariant,
} from 'importer-core'
import { FileImporter, type SettingsPickerProps } from 'importer-fundamentals'
import { LifeLabsPdfSettingsPicker } from 'lifelabs-pdf-importer-react'
import type { JSX } from 'react'

/**
 * The shell's view of the closed format registry: each entry is a
 * {@link ReactFileImporter} — the format's `FileImporter` extended with the one
 * React part a format contributes, its `SettingsPicker`. The single edit
 * point for wiring a format's UI into the shell; the importer half is
 * registered in `importer-core`.
 *
 * @packageDocumentation
 */

/**
 * A file importer with its settings picker component attached — what the
 * shell's registry holds per format. Extends `FileImporter` so every
 * importer method (detect, decode, isSourceFile, etc.) is inherited, and
 * the picker is the one addition.
 */
class ReactFileImporter<
  TFormat extends FormatKind,
  TSettings = FormatVariant[TFormat]['settings'],
  TParsed = FormatVariant[TFormat]['parsed'],
> extends FileImporter<TFormat, TSettings, TParsed> {
  readonly SettingsPicker: (props: SettingsPickerProps<TSettings>) => JSX.Element

  constructor(
    importer: FileImporter<TFormat, TSettings, TParsed>,
    SettingsPicker: (props: SettingsPickerProps<TSettings>) => JSX.Element
  ) {
    super({
      codec: importer['codec'],
      display: importer.display,
      detect: importer.detect,
      defaultSettings: importer.defaultSettings,
      decode: importer.decode,
    })
    this.SettingsPicker = SettingsPicker
  }
}

/** One registered format: its importer plus its settings picker, typed per {@link FormatKind}. */
type BoundFormat<K extends FormatKind> = ReactFileImporter<K>

/** The closed registry; its keys are the {@link FormatKind} union. */
const formatRegistry: { readonly [K in FormatKind]: BoundFormat<K> } = {
  har: new ReactFileImporter(coreRegistry.har, HarSettingsPicker),
  'lifelabs-pdf': new ReactFileImporter(coreRegistry['lifelabs-pdf'], LifeLabsPdfSettingsPicker),
  dicom: new ReactFileImporter(coreRegistry.dicom, DicomSettingsPicker),
}

export { defaultFormatSettings, formatKinds, formatRegistry }
export type { BoundFormat, FormatKind, FormatSettings, FormatVariant }
