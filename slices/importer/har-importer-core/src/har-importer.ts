import type { FhirR4ResourcesHttpApiClient } from 'fhir-r4/clients'
import type { FhirResource } from 'fhir-r4/resources'
import type { FileImporterDescriptor } from 'importer-fundamentals'

import { decodeHar } from './decode-har.ts'
import { fhirPool, fhirSources } from './fhir-pool.ts'
import { defaultHarSettings, type HarSettings } from './har-settings.ts'
import { persistFhir } from './persist-fhir.ts'

/**
 * The concrete {@link FileImporterDescriptor} for the `har` format: HAR decode
 * in, FHIR resources out, written through the FHIR store.
 *
 * @remarks
 * The one place the three seams meet — {@link decodeHar}, {@link fhirPool},
 * {@link persistFhir} — listed by the shell's closed registry. The review
 * between decode and persist is format-agnostic (`Review`), so it is not named
 * here; see this package's AGENTS.md for the roles. `sources` carries the same
 * pool grouped by source, so the review menu can label its toggles by source;
 * `pool` is those flattened.
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
  sources: fhirSources,
  pool: fhirPool,
  decode: decodeHar,
  persist: persistFhir,
}

export { harImporterDescriptor }
