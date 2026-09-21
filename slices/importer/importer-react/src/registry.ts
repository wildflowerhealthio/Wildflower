import { DicomSettingsPicker } from 'dicom-importer-react'
import { HarSettingsPicker } from 'har-importer-react'
import {
  type BoundFormat as CoreBoundFormat,
  type FormatKind,
  formatRegistry as coreRegistry,
  type FormatSettings,
} from 'importer-core'
import { type SettingsPickerProps } from 'importer-fundamentals'
import { LifeLabsPdfSettingsPicker } from 'lifelabs-pdf-importer-react'
import type { JSX } from 'react'

/**
 * The shell's view of the closed format registry: each entry is the format's
 * core {@link FileImporter} plus the React parts a format contributes — its
 * `SettingsPicker` and an optional `FilePreview` for the server source file
 * list's preview dialog. The single edit point for wiring a format's UI into
 * the shell; the importer half is registered in `importer-core`.
 *
 * @packageDocumentation
 */

/**
 * One registered format as the shell sees it: `importer-core`'s
 * {@link CoreBoundFormat} extended with its settings picker and an optional
 * file preview.
 *
 * @remarks
 * Named for what it adds, rather than reusing `importer-core`'s `BoundFormat`:
 * the two are different types — that one is the importer alone — and one name
 * for both meant the shell had to alias its import of the core registry to
 * keep them apart.
 *
 * The preview's props are `PickedFile.NamedBytes` rather than a type of their
 * own: a preview is handed a file's name and bytes, which is exactly that
 * shape, and a second interface saying so could only drift from it.
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
 * Attach a format's React slots to its core importer.
 *
 * @param importer - The format's entry in `importer-core`'s registry
 * @param slots - The format's settings form and optional file preview
 * @returns The shell's registry entry for that format
 */
const withSlots = <K extends FormatKind>(
  importer: CoreBoundFormat<K>,
  slots: {
    readonly SettingsPicker: (props: SettingsPickerProps<FormatSettings[K]>) => JSX.Element
  }
): FormatWithPicker<K> => ({ ...importer, ...slots })

/** The closed registry; its keys are the {@link FormatKind} union. */
const formatRegistry: { readonly [K in FormatKind]: FormatWithPicker<K> } = {
  har: withSlots(coreRegistry.har, { SettingsPicker: HarSettingsPicker }),
  'lifelabs-pdf': withSlots(coreRegistry['lifelabs-pdf'], {
    SettingsPicker: LifeLabsPdfSettingsPicker,
  }),
  dicom: withSlots(coreRegistry.dicom, {
    SettingsPicker: DicomSettingsPicker,
  }),
}

// Only what this module adds. `formatKinds`, `defaultFormatSettings`,
// `FormatKind` and `FormatSettings` are `importer-core`'s and are imported
// from there directly — re-exporting them here gave the package two routes to
// the same symbol, and it used both.
export { formatRegistry, withSlots }
export type { FormatWithPicker }
