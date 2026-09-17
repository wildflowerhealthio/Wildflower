import { type DicomSettings, dicomImporter } from 'dicom-importer-core'
import type { FhirResource } from 'fhir-r4/resources'
import { type HarSettings, harImporter } from 'har-importer-core'
import type { FileImporter } from 'importer-fundamentals'
import { type LifeLabsPdfSettings, lifeLabsPdfImporter } from 'lifelabs-pdf-importer-core'

/**
 * The closed, compile-time format registry: every registered
 * {@link FileImporter}, indexed by its format tag and typed through
 * {@link FormatVariant} so each entry keeps its concrete settings and parsed
 * types without erasure. The single edit point for wiring a file-format
 * binding into the importer; the React shell layers each format's
 * `SettingsPicker` on top of this record.
 *
 * @packageDocumentation
 */

/**
 * Type-level map from format tag to its concrete type pair: the format's
 * settings and the resource type it decodes to.
 */
interface FormatVariant {
  har: {
    settings: HarSettings
    parsed: FhirResource
  }
  'lifelabs-pdf': {
    settings: LifeLabsPdfSettings
    parsed: FhirResource
  }
  dicom: {
    settings: DicomSettings
    parsed: FhirResource
  }
}

/** Every registered file-format tag. */
type FormatKind = keyof FormatVariant

/**
 * The current settings of every registered format, indexed by tag — the
 * state the settings pickers edit and every decode reads.
 */
type FormatSettings = { readonly [K in FormatKind]: FormatVariant[K]['settings'] }

/**
 * One registered format's importer, parameterised on its {@link FormatKind}
 * key so every field carries the format's concrete types through
 * {@link FormatVariant}.
 */
type BoundFormat<K extends FormatKind> = FileImporter<
  K,
  FormatVariant[K]['settings'],
  FormatVariant[K]['parsed']
>

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

/** Every registered format tag, in registry (priority) order — the typed walk over the closed registry. */
const formatKinds: readonly FormatKind[] = ['har', 'lifelabs-pdf', 'dicom']

export { defaultFormatSettings, formatKinds, formatRegistry }
export type { BoundFormat, FormatKind, FormatSettings, FormatVariant }
