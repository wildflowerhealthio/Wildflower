import { type DicomSettings, dicomImporterDescriptor } from 'dicom-importer-core'
import type { FhirResource } from 'fhir-r4/resources'
import { type HarSettings, harImporterDescriptor } from 'har-importer-core'
import type { FileImporterDescriptor } from 'importer-fundamentals'
import { type LifeLabsPdfSettings, lifeLabsPdfImporterDescriptor } from 'lifelabs-pdf-importer-core'

/**
 * The closed, compile-time format registry: every registered
 * {@link FileImporterDescriptor}, indexed by its format tag and typed through
 * {@link FormatVariant} so each entry keeps its concrete settings and parsed
 * types without erasure. The single edit point for wiring a file-format
 * binding into the importer; the React shell layers each format's
 * `SettingsPicker` on top of this record.
 *
 * @remarks
 * Mirrors the `ResourceVariant` pattern in `scopes-core`'s `multi-scope.ts`:
 * a type-level map from format tag to its concrete type pair, so
 * `BoundFormat<K>` preserves per-format correlation. Where a consumer names a
 * format literally (`formatRegistry.har`) the concrete types flow through;
 * where it is format-agnostic it parameterises on {@link FormatKind}. Every
 * format decodes straight to the general `DecodedFile` — sections plus
 * notes, its own source file among them — so nothing here is per-format
 * beyond the settings type.
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
 * One registered format's descriptor, parameterised on its {@link FormatKind}
 * key so every field carries the format's concrete types through
 * {@link FormatVariant}. The registry validates type agreement at
 * construction with no casts.
 */
type BoundFormat<K extends FormatKind> = FileImporterDescriptor<
  K,
  FormatVariant[K]['settings'],
  FormatVariant[K]['parsed']
>

/** The closed registry; its keys are the {@link FormatKind} union. */
const formatRegistry: { readonly [K in FormatKind]: BoundFormat<K> } = {
  har: harImporterDescriptor,
  'lifelabs-pdf': lifeLabsPdfImporterDescriptor,
  dicom: dicomImporterDescriptor,
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
