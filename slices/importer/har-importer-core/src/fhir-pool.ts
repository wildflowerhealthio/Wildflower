import { fhirR4Source } from 'fhir-r4-source'
import type { FhirResource } from 'fhir-r4/resources'
import type { SourceDescriptor } from 'http-extraction-fundamentals'
import { rexallBeWellSource } from 'rexall-be-well-source'
import { shoppersDrugMartSource } from 'shoppers-drugmart-source'

/**
 * The registered sources a HAR archive's traffic is recognized and decoded
 * through — each grouping its pre-adopted kinds under a user-facing name and
 * detail (recognition is per-URL against the kinds flattened, never one source
 * claiming the archive). The review menu groups its include toggles by these,
 * and the flat pool routing needs is `SourceDescriptor.poolOf(fhirSources)` —
 * derived on demand, so there is no second copy to keep in sync. Registering
 * another source is one static append here.
 */
const fhirSources: readonly SourceDescriptor.SourceDescriptor<FhirResource>[] = [
  fhirR4Source,
  rexallBeWellSource,
  shoppersDrugMartSource,
]

export { fhirSources }
