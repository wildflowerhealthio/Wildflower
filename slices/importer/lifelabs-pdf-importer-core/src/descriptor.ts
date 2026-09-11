import { Effect } from 'effect'

import type { FhirR4ResourcesHttpApiClient } from 'fhir-r4/clients'
import type { FhirResource } from 'fhir-r4/resources'
import type { FileImporterDescriptor, LabeledResource } from 'importer-fundamentals'

import { decodeLifeLabsPdf } from './decode.ts'
import { persistFhir } from './persist-fhir.ts'
import { defaultLifeLabsPdfSettings, type LifeLabsPdfSettings } from './settings.ts'

/**
 * The LifeLabs PDF format's review state: the labeled resources the decode
 * pipeline produced. This format has no routing decisions (no per-URL kind
 * picks, no source toggles) — every resource the decode yields is a candidate.
 */
type LifeLabsPdfReviewState = readonly LabeledResource<FhirResource>[]

/**
 * The concrete {@link FileImporterDescriptor} for the `lifelabs-pdf` format:
 * a LifeLabs report's positioned text in, FHIR resources out, written through
 * the FHIR store.
 *
 * @remarks
 * `TReview = LifeLabsPdfReviewState` — the decoded, adopted labeled resources.
 * `resolve` is the identity: the decode pipeline already produces the final
 * labeled resources, and there are no routing decisions to interpose.
 */
const lifeLabsPdfImporterDescriptor: FileImporterDescriptor<
  LifeLabsPdfSettings,
  LifeLabsPdfReviewState,
  FhirResource,
  FhirR4ResourcesHttpApiClient
> = {
  format: 'lifelabs-pdf',
  display: {
    title: 'LifeLabs report',
    description:
      'Import lab results from a LifeLabs report PDF (as the positioned text the anonymizer extracts).',
  },
  // The picker hint lists both the source `.pdf` and the anonymizer's
  // `.json` output — `decode` reads the JSON, but the OS dialog surfaces the
  // `.pdf` a user has in hand so they can see it and route it through the
  // anonymizer first.
  accept: ['.pdf', 'application/pdf', '.json', 'application/json'],
  defaultSettings: defaultLifeLabsPdfSettings,
  decode: decodeLifeLabsPdf,
  resolve: (review) => Effect.succeed(review),
  persist: persistFhir,
}

export { lifeLabsPdfImporterDescriptor }
export type { LifeLabsPdfReviewState }
