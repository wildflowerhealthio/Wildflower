import { DicomSettingsPicker } from '@wildflowerhealthio/dicom-importer-react'
import {
  type BoundFormat as CoreBoundFormat,
  type FormatKind,
  formatRegistry as coreRegistry,
  type FormatSettings,
} from '@wildflowerhealthio/importer-core'
import { type SettingsPickerProps } from '@wildflowerhealthio/importer-fundamentals'
import { LifeLabsPdfSettingsPicker } from '@wildflowerhealthio/lifelabs-pdf-importer-react'
import type { JSX } from 'react'

/**
 * The shell's view of the closed format registry: each entry is the format's
 * core {@link FileImporter} plus the React parts a format contributes — its
 * `SettingsPicker`, when the format has settings. The single edit point for
 * wiring a format's UI into the shell; the importer half is registered in
 * `importer-core`.
 *
 * @packageDocumentation
 */

/** A format's settings form: a controlled picker over its {@link FormatSettings} entry. */
type FormatSettingsPicker<K extends FormatKind> = (
  props: SettingsPickerProps<FormatSettings[K]>
) => JSX.Element

/**
 * A format's settings picker slot: forbidden for a format whose settings are
 * `null`, required for every other, so a format with settings that is missing
 * its picker fails to compile.
 */
type SettingsPickerSlot<K extends FormatKind> = FormatSettings[K] extends null
  ? { readonly SettingsPicker?: never }
  : { readonly SettingsPicker: FormatSettingsPicker<K> }

/**
 * One registered format as the shell sees it: `importer-core`'s
 * {@link CoreBoundFormat} extended with its settings picker slot.
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
type FormatWithComponents<K extends FormatKind> = CoreBoundFormat<K> & SettingsPickerSlot<K>

/**
 * Attach a format's React slots to its core importer.
 *
 * @param importer - The format's entry in `importer-core`'s registry
 * @param componentSet - The format's settings form
 * @returns The shell's registry entry for that format
 */
const withComponents = <K extends FormatKind>(
  importer: CoreBoundFormat<K>,
  componentSet: SettingsPickerSlot<K>
): FormatWithComponents<K> => ({ ...importer, ...componentSet })

/**
 * The closed registry; its keys are the {@link FormatKind} union. HAR has no
 * settings, so its entry is the core importer as it is.
 */
const formatRegistry: { readonly [K in FormatKind]: FormatWithComponents<K> } = {
  har: coreRegistry.har,
  'lifelabs-pdf': withComponents(coreRegistry['lifelabs-pdf'], {
    SettingsPicker: LifeLabsPdfSettingsPicker,
  }),
  dicom: withComponents(coreRegistry.dicom, {
    SettingsPicker: DicomSettingsPicker,
  }),
}

// Only what this module adds. `formatKinds`, `defaultFormatSettings`,
// `FormatKind` and `FormatSettings` are `importer-core`'s and are imported
// from there directly — re-exporting them here gave the package two routes to
// the same symbol, and it used both.
export { formatRegistry, withComponents }
export type { FormatSettingsPicker, FormatWithComponents }
