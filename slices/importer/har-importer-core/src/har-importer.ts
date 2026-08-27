import type { FhirR4ResourcesHttpApiClient } from 'fhir-r4/clients'
import type { FhirResource } from 'fhir-r4/resources'
import type { FileImporterDescriptor } from 'importer-fundamentals'

import { decodeHar } from './decode-har.ts'
import { fhirPool } from './fhir-pool.ts'
import { defaultHarSettings, type HarSettings } from './har-settings.ts'
import { persistFhir } from './persist-fhir.ts'

/**
 * The concrete {@link FileImporterDescriptor} for the `har` format: HAR decode
 * in, FHIR resources out, written through the FHIR store.
 *
 * @remarks
 * The one place the three seams the HAR import is assembled from meet —
 * `web-trace-core`'s HAR codec ({@link decodeHar}), the FHIR R4 response-kind
 * pool ({@link fhirPool}), and the FHIR persist sink ({@link persistFhir}) — bound
 * to `TResource = FhirResource` and `R = FhirR4ResourcesHttpApiClient`. The
 * per-response review that sits between decode and persist is format-agnostic
 * (`importer-fundamentals`' `Review`), so it is not named here. The shell lists
 * this descriptor in its closed `format → …` registry.
 *
 * `persist` hands `fhir-r4`'s `ResourceWriteFailure`s straight back; they satisfy
 * `PersistFailure` structurally, so a drift in either shape is a compile error
 * here rather than a silent divergence.
 */
const harImporterDescriptor: FileImporterDescriptor<
  HarSettings,
  FhirResource,
  FhirR4ResourcesHttpApiClient
> = {
  format: 'har',
  display: {
    title: 'HAR archive',
    description: 'Import FHIR records from a captured browsing session.',
  },
  defaultSettings: defaultHarSettings,
  pool: fhirPool,
  decode: decodeHar,
  persist: persistFhir,
}

export { harImporterDescriptor }
