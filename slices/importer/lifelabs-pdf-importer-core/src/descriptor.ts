import type { FhirR4ResourcesHttpApiClient } from 'fhir-r4/clients'
import type { FhirResource } from 'fhir-r4/resources'
import type { FileImporterDescriptor } from 'importer-fundamentals'

import { decodeLifeLabsPdf } from './decode.ts'
import { persistFhir } from './persist-fhir.ts'
import { defaultLifeLabsPdfSettings, type LifeLabsPdfSettings } from './settings.ts'
import { lifeLabsPdfSource } from './source.ts'

/**
 * The concrete {@link FileImporterDescriptor} for the `lifelabs-pdf` format:
 * a LifeLabs report's positioned text in, FHIR resources out, written through
 * the FHIR store.
 */
const lifeLabsPdfImporterDescriptor: FileImporterDescriptor<
  LifeLabsPdfSettings,
  FhirResource,
  FhirR4ResourcesHttpApiClient
> = {
  format: 'lifelabs-pdf',
  display: {
    title: 'LifeLabs report',
    description:
      'Import lab results from a LifeLabs report PDF (as the positioned text the anonymizer extracts).',
  },
  defaultSettings: defaultLifeLabsPdfSettings,
  sources: [lifeLabsPdfSource],
  decode: decodeLifeLabsPdf,
  persist: persistFhir,
}

export { lifeLabsPdfImporterDescriptor }
