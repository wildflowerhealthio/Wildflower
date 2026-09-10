import { Effect, type ParseResult } from 'effect'
import type { FhirR4ResourcesHttpApiClient } from 'fhir-r4/clients'
import type { FhirResource } from 'fhir-r4/resources'
import {
  type HarReviewState,
  type HarSelection,
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
import type {
  FileImporterDescriptor,
  LabeledResource,
  PersistFailure,
  Review,
} from 'importer-fundamentals'
import { lifeLabsPdfImporterDescriptor } from 'lifelabs-pdf-importer-core'
import { LifeLabsPdfSettingsPicker } from 'lifelabs-pdf-importer-react'
import type { JSX } from 'react'

/**
 * The closed, compile-time format registry. Each format is paired with its
 * React views via a `bind` closure that seals `TReview` — the shell works
 * with {@link BoundFormat} and never names the review type.
 *
 * @remarks
 * Mirrors the anonymizer's `bind` pattern: `bind` takes a descriptor and the
 * React affordances for the *same* `TReview` and returns a `BoundFormat`
 * whose `TReview` never escapes. A registration whose views disagree with
 * its descriptor's type fails to compile.
 *
 * @packageDocumentation
 */

/**
 * The props every format-specific review body receives: the opaque review
 * state, the resolved labeled resources, the per-resource selection, and
 * callbacks for both axes.
 */
interface ReviewBodyAdapterProps {
  readonly review: unknown
  readonly labeled: readonly LabeledResource<FhirResource>[]
  readonly selection: Review.Selection<FhirResource>
  readonly onReviewChange: (review: unknown) => void
  readonly onSelectionChange: (selection: Review.Selection<FhirResource>) => void
}

/**
 * One registered format, its `TReview` closed over. The shell routes over
 * these without naming the review type.
 */
interface BoundFormat {
  readonly format: string
  readonly display: { readonly title: string; readonly description: string }
  readonly defaultSettings: unknown
  readonly decode: (
    fileText: string,
    settings: unknown
  ) => Effect.Effect<unknown, ParseResult.ParseError>
  readonly resolve: (review: unknown) => Effect.Effect<readonly LabeledResource<FhirResource>[]>
  readonly persist: (
    resources: readonly FhirResource[],
    sourceRef: string
  ) => Effect.Effect<readonly PersistFailure[], never, FhirR4ResourcesHttpApiClient>
  readonly SettingsPicker: (props: SettingsPickerProps<unknown>) => JSX.Element
  /**
   * The format-specific review body, if the format has routing decisions
   * beyond the general per-resource selection. `null` when the general
   * per-resource view (labeled resources + exclude/edit) suffices.
   */
  readonly ReviewBody: ((props: ReviewBodyAdapterProps) => JSX.Element) | null
}

/**
 * Pairs a descriptor with its React views, sealing `TReview` in the closure.
 */
const bind = <TSettings, TReview, R>(
  descriptor: FileImporterDescriptor<TSettings, TReview, FhirResource, R>,
  SettingsPicker: (props: SettingsPickerProps<TSettings>) => JSX.Element,
  ReviewBody:
    | ((props: {
        readonly review: TReview
        readonly labeled: readonly LabeledResource<FhirResource>[]
        readonly selection: Review.Selection<FhirResource>
        readonly onReviewChange: (review: TReview) => void
        readonly onSelectionChange: (selection: Review.Selection<FhirResource>) => void
      }) => JSX.Element)
    | null
): BoundFormat => ({
  format: descriptor.format,
  display: descriptor.display,
  defaultSettings: descriptor.defaultSettings,
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- bind erases TReview/TSettings
  decode: descriptor.decode as BoundFormat['decode'],
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- bind erases TReview
  resolve: descriptor.resolve as BoundFormat['resolve'],
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- bind erases R
  persist: descriptor.persist as BoundFormat['persist'],
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- bind erases TSettings
  SettingsPicker: SettingsPicker as BoundFormat['SettingsPicker'],
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- bind erases TReview
  ReviewBody: ReviewBody as BoundFormat['ReviewBody'],
})

/** The pool for HAR preview computation. */
const harPool = SourceDescriptor.poolOf(fhirSources)

/** The HAR format's review body: wraps the HAR-specific UI behind the bound adapter signature. */
// oxlint-disable-next-line react/only-export-components -- internal to the registry's bind closure, not exported
const HarReviewBodyAdapter = ({
  review,
  labeled: _labeled,
  selection,
  onReviewChange,
  onSelectionChange,
}: {
  readonly review: HarReviewState
  readonly labeled: readonly LabeledResource<FhirResource>[]
  readonly selection: Review.Selection<FhirResource>
  readonly onReviewChange: (review: HarReviewState) => void
  readonly onSelectionChange: (selection: Review.Selection<FhirResource>) => void
}): JSX.Element => {
  const previews = Effect.runSync(harPreview(harPool, review.responses, review.harSelection))
  return (
    <HarReviewBody
      responses={review.responses}
      sources={fhirSources}
      previews={previews}
      harSelection={review.harSelection}
      selection={selection}
      onHarSelectionChange={(harSelection: HarSelection) =>
        onReviewChange({ ...review, harSelection })
      }
      onSelectionChange={onSelectionChange}
    />
  )
}

/** The closed registry; its keys are the {@link Format} union. */
const formatRegistry = {
  har: bind(harImporterDescriptor, HarSettingsPicker, HarReviewBodyAdapter),
  'lifelabs-pdf': bind(lifeLabsPdfImporterDescriptor, LifeLabsPdfSettingsPicker, null),
} as const

/** Every registered file-format tag. */
type Format = keyof typeof formatRegistry

export { formatRegistry }
export type { BoundFormat, Format, ReviewBodyAdapterProps }
