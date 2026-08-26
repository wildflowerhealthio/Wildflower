import { fhirR4Importer } from 'fhir-r4-importer'
import type { FhirResource } from 'fhir-r4/resources'
import type { Importer } from 'importer-fundamentals'

/**
 * The closed, compile-time list of importers an archive can be imported
 * through.
 *
 * @remarks
 * Registering an importer is one static edit — appending its
 * `Importer.Importer` value (assembled in its own importer project, the way
 * `fhir-r4-importer` exports `fhirR4Importer`) — and there is no runtime
 * registry. Only `fhir-r4` is registered so far; the recognizer specificity
 * ranking (see `fhir-r4-importer`'s `FHIR_R4_SPECIFICITY`) reserves seats for
 * the neighbours.
 */
const importers: readonly Importer.Importer<FhirResource>[] = [fhirR4Importer]

export { importers }
