import { Effect, type ParseResult } from 'effect'
import type { FhirR4ResourcesHttpApiClient } from 'fhir-r4/clients'
import type { FhirResource } from 'fhir-r4/resources'
import {
  type HarReviewState,
  type HarSelection,
  type HarSettings,
  fhirSources,
  harImporterDescriptor,
  preview as harPreview,
} from 'har-importer-core'
import {
  HarSettingsPicker,
  ReviewBody as HarReviewBody,
  type SettingsPickerProps,
} from 'har-importer-react'
import { SourceDescriptor } from 'http-extraction-fundamentals'
import type { LabeledResource, PersistFailure, Review } from 'importer-fundamentals'
import {
  type LifeLabsPdfReviewState,
  type LifeLabsPdfSettings,
  lifeLabsPdfImporterDescriptor,
} from 'lifelabs-pdf-importer-core'
import { LifeLabsPdfSettingsPicker } from 'lifelabs-pdf-importer-react'
import { type ComponentType, type JSX, useMemo } from 'react'

/**
 * The closed, compile-time format registry. Each format maps to its concrete
 * types through {@link FormatVariant}, giving {@link BoundFormat} indexed
 * access that recovers concrete types without erasure — the registration
 * validates type agreement at construction, no casts.
 *
 * @remarks
 * Mirrors the `ResourceVariant` pattern in `scopes-core`'s `multi-scope.ts`:
 * a type-level map from format tag to its concrete type quadruple, so
 * `BoundFormat<K>` preserves per-format correlation. Where the shell
 * hardcodes `formatRegistry.har`, the concrete types flow through; where a
 * consumer is format-agnostic it parameterises on `FormatKind`.
 *
 * @packageDocumentation
 */

/**
 * Type-level map from format tag to its concrete type quadruple. Each entry
 * defines the format's settings, review state, parsed resource type, and
 * the services its write sink requires.
 */
interface FormatVariant {
  har: {
    settings: HarSettings
    review: HarReviewState
    parsed: FhirResource
    requirements: FhirR4ResourcesHttpApiClient
  }
  'lifelabs-pdf': {
    settings: LifeLabsPdfSettings
    review: LifeLabsPdfReviewState
    parsed: FhirResource
    requirements: FhirR4ResourcesHttpApiClient
  }
}

/** Every registered file-format tag. */
type FormatKind = keyof FormatVariant

/**
 * The props every format-specific review body receives, parameterised on the
 * format key so the review, labeled resources, and selection carry the
 * format's concrete types.
 */
interface ReviewBodyAdapterProps<K extends FormatKind> {
  readonly review: FormatVariant[K]['review']
  readonly labeled: readonly LabeledResource<FormatVariant[K]['parsed']>[]
  readonly selection: Review.Selection<FormatVariant[K]['parsed']>
  readonly onReviewChange: (review: FormatVariant[K]['review']) => void
  readonly onSelectionChange: (selection: Review.Selection<FormatVariant[K]['parsed']>) => void
}

/**
 * One registered format, parameterised on its {@link FormatKind} key. Every
 * field carries the format's concrete types through {@link FormatVariant},
 * and the registry validates type agreement at construction with no casts.
 */
interface BoundFormat<K extends FormatKind> {
  readonly format: K
  readonly display: { readonly title: string; readonly description: string }
  readonly accept: readonly string[]
  readonly defaultSettings: FormatVariant[K]['settings']
  readonly decode: (
    fileText: string,
    settings: FormatVariant[K]['settings']
  ) => Effect.Effect<FormatVariant[K]['review'], ParseResult.ParseError>
  readonly resolve: (
    review: FormatVariant[K]['review']
  ) => Effect.Effect<readonly LabeledResource<FormatVariant[K]['parsed']>[]>
  readonly persist: (
    resources: readonly FormatVariant[K]['parsed'][],
    sourceRef: string
  ) => Effect.Effect<readonly PersistFailure[], never, FormatVariant[K]['requirements']>
  readonly SettingsPicker: (props: SettingsPickerProps<FormatVariant[K]['settings']>) => JSX.Element
  /**
   * The format-specific review body, when the format has routing decisions
   * beyond the general per-resource selection. `null` when the general
   * per-resource view (labeled resources + exclude/edit) suffices.
   */
  readonly ReviewBody: ComponentType<ReviewBodyAdapterProps<K>> | null
}

/** The pool for HAR preview computation. */
const harPool = SourceDescriptor.poolOf(fhirSources)

/** The HAR format's review body: wraps the HAR-specific UI behind the bound adapter signature. */
// oxlint-disable-next-line react/only-export-components -- internal to the registry, not exported
const HarReviewBodyAdapter = ({
  review,
  selection,
  onReviewChange,
  onSelectionChange,
}: ReviewBodyAdapterProps<'har'>): JSX.Element => {
  const previews = useMemo(
    () => Effect.runSync(harPreview(harPool, review.responses, review.harSelection)),
    [review.responses, review.harSelection]
  )
  return (
    <HarReviewBody
      responses={review.responses}
      sources={fhirSources}
      previews={previews}
      harSelection={review.harSelection}
      selection={selection}
      onHarSelectionChange={(harSelection: HarSelection.Selection) =>
        onReviewChange({ ...review, harSelection })
      }
      onSelectionChange={onSelectionChange}
    />
  )
}

/** The closed registry; its keys are the {@link FormatKind} union. */
const formatRegistry: { readonly [K in FormatKind]: BoundFormat<K> } = {
  har: {
    format: 'har',
    display: harImporterDescriptor.display,
    accept: harImporterDescriptor.accept,
    defaultSettings: harImporterDescriptor.defaultSettings,
    decode: harImporterDescriptor.decode,
    resolve: harImporterDescriptor.resolve,
    persist: harImporterDescriptor.persist,
    SettingsPicker: HarSettingsPicker,
    ReviewBody: HarReviewBodyAdapter,
  },
  'lifelabs-pdf': {
    format: 'lifelabs-pdf',
    display: lifeLabsPdfImporterDescriptor.display,
    accept: lifeLabsPdfImporterDescriptor.accept,
    defaultSettings: lifeLabsPdfImporterDescriptor.defaultSettings,
    decode: lifeLabsPdfImporterDescriptor.decode,
    resolve: lifeLabsPdfImporterDescriptor.resolve,
    persist: lifeLabsPdfImporterDescriptor.persist,
    SettingsPicker: LifeLabsPdfSettingsPicker,
    ReviewBody: null,
  },
}

export { formatRegistry }
export type { BoundFormat, FormatKind, FormatVariant, ReviewBodyAdapterProps }
