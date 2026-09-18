import { DicomSettingsPicker } from 'dicom-importer-react'
import { HarSettingsPicker } from 'har-importer-react'
import {
  type BoundFormat as CoreBoundFormat,
  defaultFormatSettings,
  type FormatKind,
  formatKinds,
  formatRegistry as coreRegistry,
  type FormatSettings,
} from 'importer-core'
import { type SettingsPickerProps } from 'importer-fundamentals'
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
 * One registered format as the shell sees it: `importer-core`'s
 * {@link CoreBoundFormat} extended with its settings picker.
 *
 * @remarks
 * Named for what it adds, rather than reusing `importer-core`'s `BoundFormat`:
 * the two are different types — that one is the importer alone — and one name
 * for both meant the shell had to alias its import of the core registry to
 * keep them apart.
 *
 * An intersection built by spreading the core importer, not a subclass: a
 * subclass had to hand-copy every field through a copy constructor, so a field
 * added to `FileImporter` would have been dropped here with no type error
 * anywhere. `FileImporter` has no prototype, so the spread is total.
 */
type FormatWithPicker<K extends FormatKind> = CoreBoundFormat<K> & {
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
  importer: CoreBoundFormat<K>,
  SettingsPicker: (props: SettingsPickerProps<FormatSettings[K]>) => JSX.Element
): FormatWithPicker<K> => ({ ...importer, SettingsPicker })

/** The closed registry; its keys are the {@link FormatKind} union. */
const formatRegistry: { readonly [K in FormatKind]: FormatWithPicker<K> } = {
  har: withSettingsPicker(coreRegistry.har, HarSettingsPicker),
  'lifelabs-pdf': withSettingsPicker(coreRegistry['lifelabs-pdf'], LifeLabsPdfSettingsPicker),
  dicom: withSettingsPicker(coreRegistry.dicom, DicomSettingsPicker),
}

export { defaultFormatSettings, formatKinds, formatRegistry, withSettingsPicker }
export type { FormatWithPicker, FormatKind, FormatSettings }
