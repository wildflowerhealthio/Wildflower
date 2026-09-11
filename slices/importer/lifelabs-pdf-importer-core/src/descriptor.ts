import type { FhirR4ResourcesHttpApiClient } from 'fhir-r4/clients'
import type { FhirResource } from 'fhir-r4/resources'
import type { FileImporterDescriptor } from 'importer-fundamentals'

import { decodeLifeLabsPdf } from './decode.ts'
import { detectLifeLabsPdf } from './detect.ts'
import { defaultLifeLabsPdfSettings, type LifeLabsPdfSettings } from './settings.ts'
import { uploadSource } from './upload-source.ts'

/**
 * The concrete {@link FileImporterDescriptor} for the `lifelabs-pdf` format:
 * a LifeLabs report's positioned text in, FHIR resources out. Persistence is
 * shell-owned — every FHIR-targeting importer writes through one shared
 * `POST /` batch bundle (`persistBatchBundle` in `fhir-r4/clients`), so no
 * format brings its own `persist`.
 *
 * @remarks
 * `decode` yields one section per report the PDF carries and no notes — this
 * format has no routing decisions (no per-URL kind picks, no source toggles),
 * so every resource the decode yields is a review candidate.
 */
const lifeLabsPdfImporterDescriptor: FileImporterDescriptor<
  LifeLabsPdfSettings,
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
  uploadSource,
}

export { lifeLabsPdfImporterDescriptor }
