import type { Effect, ParseResult } from 'effect'
import type { FhirR4ResourcesHttpApiClient } from 'fhir-r4/clients'
import type { FhirResource } from 'fhir-r4/resources'
import { type HarSettings, harImporterDescriptor } from 'har-importer-core'
import { HarSettingsPicker } from 'har-importer-react'
import type { DecodedFile, DocumentReferenceType, SettingsPickerProps } from 'importer-fundamentals'
import { type LifeLabsPdfSettings, lifeLabsPdfImporterDescriptor } from 'lifelabs-pdf-importer-core'
import { LifeLabsPdfSettingsPicker } from 'lifelabs-pdf-importer-react'
import type { JSX } from 'react'

/**
 * The closed, compile-time format registry. Each format maps to its concrete
 * types through {@link FormatVariant}, giving {@link BoundFormat} indexed
 * access that recovers concrete types without erasure — the registration
 * validates type agreement at construction, no casts.
 *
 * @remarks
 * Mirrors the `ResourceVariant` pattern in `scopes-core`'s `multi-scope.ts`:
 * a type-level map from format tag to its concrete type triple, so
 * `BoundFormat<K>` preserves per-format correlation. Where the shell
 * hardcodes `formatRegistry.har`, the concrete types flow through; where a
 * consumer is format-agnostic it parameterises on `FormatKind`. Every format
 * decodes straight to the general {@link DecodedFile} — sections plus notes —
 * so the shell's review needs no per-format review state or review UI; the
 * one per-format UI part left is the settings picker.
 */

/**
 * Type-level map from format tag to its concrete type triple. Each entry
 * defines the format's settings, parsed resource type, and the services its
 * write sink requires.
 */
interface FormatVariant {
  har: {
    settings: HarSettings
    parsed: FhirResource
    requirements: FhirR4ResourcesHttpApiClient
  }
  'lifelabs-pdf': {
    settings: LifeLabsPdfSettings
    parsed: FhirResource
    requirements: FhirR4ResourcesHttpApiClient
  }
}

/** Every registered file-format tag. */
type FormatKind = keyof FormatVariant

/**
 * The current settings of every registered format, indexed by tag — the
 * shell-held state the settings pickers edit and every decode reads.
 */
type FormatSettings = { readonly [K in FormatKind]: FormatVariant[K]['settings'] }

/**
 * One registered format, parameterised on its {@link FormatKind} key. Every
 * field carries the format's concrete types through {@link FormatVariant},
 * and the registry validates type agreement at construction with no casts.
 */
interface BoundFormat<K extends FormatKind> {
  readonly format: K
  readonly display: { readonly title: string; readonly description: string }
  readonly accept: readonly string[]
  readonly detect: (fileBytes: Uint8Array, fileName: string) => boolean
  readonly defaultSettings: FormatVariant[K]['settings']
  readonly decode: (
    fileBytes: Uint8Array,
    settings: FormatVariant[K]['settings']
  ) => Effect.Effect<DecodedFile<FormatVariant[K]['parsed']>, ParseResult.ParseError>
  readonly uploadSource: (picked: {
    readonly fileName: string
    readonly bytes: Uint8Array
  }) => Effect.Effect<string, unknown, FormatVariant[K]['requirements']>
  readonly archiveCategoryToken: string
  readonly isArchive: (resource: DocumentReferenceType) => boolean
  readonly archiveFromDocumentReference: (
    resource: DocumentReferenceType
  ) => Effect.Effect<
    { readonly fileName: string; readonly bytes: Uint8Array },
    ParseResult.ParseError
  >
  readonly archiveContentType: string
  readonly SettingsPicker: (props: SettingsPickerProps<FormatVariant[K]['settings']>) => JSX.Element
}

/** The closed registry; its keys are the {@link FormatKind} union. */
const formatRegistry: { readonly [K in FormatKind]: BoundFormat<K> } = {
  har: {
    format: 'har',
    display: harImporterDescriptor.display,
    accept: harImporterDescriptor.accept,
    detect: harImporterDescriptor.detect,
    defaultSettings: harImporterDescriptor.defaultSettings,
    decode: harImporterDescriptor.decode,
    uploadSource: harImporterDescriptor.uploadSource,
    archiveCategoryToken: harImporterDescriptor.archiveCategoryToken,
    isArchive: harImporterDescriptor.isArchive,
    archiveFromDocumentReference: harImporterDescriptor.archiveFromDocumentReference,
    archiveContentType: harImporterDescriptor.archiveContentType,
    SettingsPicker: HarSettingsPicker,
  },
  'lifelabs-pdf': {
    format: 'lifelabs-pdf',
    display: lifeLabsPdfImporterDescriptor.display,
    accept: lifeLabsPdfImporterDescriptor.accept,
    detect: lifeLabsPdfImporterDescriptor.detect,
    defaultSettings: lifeLabsPdfImporterDescriptor.defaultSettings,
    decode: lifeLabsPdfImporterDescriptor.decode,
    uploadSource: lifeLabsPdfImporterDescriptor.uploadSource,
    archiveCategoryToken: lifeLabsPdfImporterDescriptor.archiveCategoryToken,
    isArchive: lifeLabsPdfImporterDescriptor.isArchive,
    archiveFromDocumentReference: lifeLabsPdfImporterDescriptor.archiveFromDocumentReference,
    archiveContentType: lifeLabsPdfImporterDescriptor.archiveContentType,
    SettingsPicker: LifeLabsPdfSettingsPicker,
  },
}

/** The default settings of every registered format — the state a fresh shell seeds. */
const defaultFormatSettings: FormatSettings = {
  har: formatRegistry.har.defaultSettings,
  'lifelabs-pdf': formatRegistry['lifelabs-pdf'].defaultSettings,
}

/** Every registered format tag, in registry (priority) order — the typed walk over the closed registry. */
const formatKinds: readonly FormatKind[] = ['har', 'lifelabs-pdf']

export { defaultFormatSettings, formatKinds, formatRegistry }
export type { BoundFormat, FormatKind, FormatSettings, FormatVariant }
