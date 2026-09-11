import { Effect } from 'effect'

import type { FhirR4ResourcesHttpApiClient } from 'fhir-r4/clients'
import type { FhirResource } from 'fhir-r4/resources'
import { type Extraction, SourceDescriptor } from 'http-extraction-fundamentals'
import type { FileImporterDescriptor, LabeledResource } from 'importer-fundamentals'

import { decodeHar } from './decode-har.ts'
import { fhirSources } from './fhir-pool.ts'
import * as HarSelection from './har-selection.ts'
import { defaultHarSettings, type HarSettings } from './har-settings.ts'
import { persistFhir } from './persist-fhir.ts'
import { preview } from './review.ts'

/**
 * The HAR format's opaque review state: the decoded responses plus the
 * HAR-specific routing selection (kind toggles + pick overrides).
 */
interface HarReviewState {
  readonly responses: readonly Extraction.Input[]
  readonly harSelection: HarSelection.Selection
}

/** The pool derived once from the sources — used by `resolve`. */
const pool = SourceDescriptor.poolOf(fhirSources)

/**
 * The concrete {@link FileImporterDescriptor} for the `har` format: HAR decode
 * in, FHIR resources out, written through the FHIR store.
 *
 * @remarks
 * `TReview = HarReviewState` — the decoded responses plus the HAR-specific
 * routing selection. `resolve` runs the HTTP preview (recognition + parse)
 * and maps each parsed resource to a `LabeledResource` with a one-line
 * description from `describeResource`.
 */
const harImporterDescriptor: FileImporterDescriptor<
  HarSettings,
  HarReviewState,
  FhirResource,
  FhirR4ResourcesHttpApiClient
> = {
  format: 'har',
  display: {
    title: 'HAR archive',
    description: 'Import FHIR records from a captured browsing session.',
  },
  accept: ['.har', 'application/json'],
  defaultSettings: defaultHarSettings,
  decode: (fileText, settings) =>
    Effect.map(decodeHar(fileText, settings), (responses) => ({
      responses,
      harSelection: HarSelection.initial(pool),
    })),
  resolve: (review) =>
    Effect.map(preview(pool, review.responses, review.harSelection), (previews) =>
      previews.flatMap((entry) =>
        entry.outcome._tag === 'resources'
          ? entry.outcome.resources.map((resource): LabeledResource<FhirResource> => ({
              key: resource.key,
              title: `${resource.resource.resourceType}/${resource.resource.id ?? '?'}`,
              resource: resource.resource,
            }))
          : []
      )
    ),
  persist: persistFhir,
}

export { harImporterDescriptor }
export type { HarReviewState }
