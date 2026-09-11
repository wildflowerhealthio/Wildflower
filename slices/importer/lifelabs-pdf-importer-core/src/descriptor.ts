import { Effect } from 'effect'

import type { FhirR4ResourcesHttpApiClient } from 'fhir-r4/clients'
import type { FhirResource } from 'fhir-r4/resources'
import type { FileImporterDescriptor, LabeledResource } from 'importer-fundamentals'

import { decodeLifeLabsPdf } from './decode.ts'
import { detectLifeLabsPdf } from './detect.ts'
import { persistFhir } from './persist-fhir.ts'
import { defaultLifeLabsPdfSettings, type LifeLabsPdfSettings } from './settings.ts'
import { uploadSource } from './upload-source.ts'

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
    description: 'Import lab results from a LifeLabs report PDF.',
  },
  // The picker hint is the report PDF itself — this binding opens the PDF's
  // bytes end-to-end (`positioned-text-web`'s extraction ↦ dialect ↦ FHIR).
  // The anonymizer's positioned-text JSON is a separate artifact the
  // anonymizer downloads for redaction; this importer does not accept it.
  accept: ['.pdf', 'application/pdf'],
  detect: detectLifeLabsPdf,
  defaultSettings: defaultLifeLabsPdfSettings,
  decode: decodeLifeLabsPdf,
  resolve: (review) => Effect.succeed(review),
  uploadSource,
  persist: persistFhir,
}

export { lifeLabsPdfImporterDescriptor }
export type { LifeLabsPdfReviewState }
