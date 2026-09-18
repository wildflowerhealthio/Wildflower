import { DicomSettingsPicker } from 'dicom-importer-react'
import { HarSettingsPicker } from 'har-importer-react'
import {
  defaultFormatSettings,
  type FormatKind,
  formatKinds,
  formatRegistry as coreRegistry,
  type FormatSettings,
} from 'importer-core'
import { type FileImporter, type SettingsPickerProps } from 'importer-fundamentals'
import { LifeLabsPdfSettingsPicker } from 'lifelabs-pdf-importer-react'
import type { JSX } from 'react'

/**
 * The shell's view of the closed format registry: each entry is the format's
 * core {@link FileImporter} plus the one React part a format contributes, its
 * `SettingsPicker`. The single edit point for wiring a format's UI into the
 * shell; the importer half is registered in `importer-core`.
 *
 * @packageDocumentation
 */

/**
 * One registered format: its core importer extended with its settings picker.
 *
 * @remarks
 * An intersection built by spreading the core importer, not a subclass: a
 * subclass had to hand-copy every field through a copy constructor, so a field
 * added to `FileImporter` would have been dropped here with no type error
 * anywhere. `FileImporter` has no prototype, so the spread is total.
 */
type BoundFormat<K extends FormatKind> = FileImporter.Type<FormatSettings[K], K> & {
  readonly SettingsPicker: (props: SettingsPickerProps<FormatSettings[K]>) => JSX.Element
}

/**
 * Attach a format's settings picker to its core importer.
 *
 * @param importer - The format's entry in `importer-core`'s registry
 * @param SettingsPicker - The format's settings form
 * @returns The shell's registry entry for that format
 */
const withSettingsPicker = <K extends FormatKind>(
  importer: FileImporter.Type<FormatSettings[K], K>,
  SettingsPicker: (props: SettingsPickerProps<FormatSettings[K]>) => JSX.Element
): BoundFormat<K> => ({ ...importer, SettingsPicker })

/** The closed registry; its keys are the {@link FormatKind} union. */
const formatRegistry: { readonly [K in FormatKind]: BoundFormat<K> } = {
  har: withSettingsPicker(coreRegistry.har, HarSettingsPicker),
  'lifelabs-pdf': withSettingsPicker(coreRegistry['lifelabs-pdf'], LifeLabsPdfSettingsPicker),
  dicom: withSettingsPicker(coreRegistry.dicom, DicomSettingsPicker),
}

export { defaultFormatSettings, formatKinds, formatRegistry, withSettingsPicker }
export type { BoundFormat, FormatKind, FormatSettings }
