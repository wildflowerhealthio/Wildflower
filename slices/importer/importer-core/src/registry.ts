import { type DicomSettings, dicomImporter } from 'dicom-importer-core'
import { type HarSettings, harImporter } from 'har-importer-core'
import type { FileImporter } from 'importer-fundamentals'
import { type LifeLabsPdfSettings, lifeLabsPdfImporter } from 'lifelabs-pdf-importer-core'

/**
 * The closed, compile-time format registry: every registered
 * {@link FileImporter}, indexed by its format tag and typed through
 * {@link BoundFormat} so each entry keeps its concrete settings without
 * erasure. The React shell layers each format's `SettingsPicker` on top of
 * this record.
 *
 * @remarks
 * Wiring a binding in is three edits *here* — the {@link FormatSettings} map,
 * the {@link formatRegistry} literal, and {@link defaultFormatSettings} — plus
 * `collectFormats` in `read-batch.ts` and the picker entry in
 * `importer-react`'s registry. Every one of them is a mapped or exhaustive
 * type over {@link FormatKind}, so a format added to `FormatSettings` and
 * missed anywhere else **fails to compile**; none of them can drift silently.
 * {@link formatKinds} is derived from the registry rather than listed, because
 * a hand-written `readonly FormatKind[]` is the one slot a missing entry
 * *would* have slipped through.
 *
 * @packageDocumentation
 */

/** Every registered file-format tag. */
type FormatKind = keyof FormatSettings

/**
 * The current settings of every registered format, indexed by tag — the
 * state the settings pickers edit and every decode reads.
 */
type FormatSettings = {
  har: HarSettings
  'lifelabs-pdf': LifeLabsPdfSettings
  dicom: DicomSettings
}

/**
 * One registered format's importer, parameterised on its {@link FormatKind}
 * key so every field carries the format's concrete types.
 */
type BoundFormat<K extends FormatKind> = FileImporter<FormatSettings[K], K>

/** The closed registry; its keys are the {@link FormatKind} union. */
const formatRegistry: { readonly [K in FormatKind]: BoundFormat<K> } = {
  har: harImporter,
  'lifelabs-pdf': lifeLabsPdfImporter,
  dicom: dicomImporter,
}

/** The default settings of every registered format — the state a fresh import seeds. */
const defaultFormatSettings: FormatSettings = {
  har: formatRegistry.har.defaultSettings,
  'lifelabs-pdf': formatRegistry['lifelabs-pdf'].defaultSettings,
  dicom: formatRegistry.dicom.defaultSettings,
}

/** Whether a key is one the registry holds — the runtime check behind {@link formatKinds}. */
const isFormatKind = (key: string): key is FormatKind => Object.hasOwn(formatRegistry, key)

/**
 * Every registered format tag, in registry (priority) order — the typed walk
 * over the closed registry.
 *
 * @remarks
 * Derived from {@link formatRegistry} rather than listed, so it cannot fall
 * out of step with it: a format added to the registry is walked from that
 * edit alone. The order is the registry literal's own key order, which is
 * what `detect` priority means.
 */
const formatKinds: readonly FormatKind[] = Object.keys(formatRegistry).filter(isFormatKind)

export { defaultFormatSettings, formatKinds, formatRegistry }
export type { BoundFormat, FormatKind, FormatSettings }
