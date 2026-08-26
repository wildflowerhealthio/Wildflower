import { fhirR4Source } from 'fhir-r4-source'
import type { FhirResource } from 'fhir-r4/resources'
import type { Source } from 'http-extraction-fundamentals'

/**
 * The closed, compile-time list of HTTP sources a HAR archive's traffic can
 * be recognized as and extracted through.
 *
 * @remarks
 * Registering a source is one static edit — appending its `Source.Source`
 * value (assembled in its own package under `slices/http-extraction`, the way
 * `fhir-r4-source` exports `fhirR4Source`) — and there is no runtime
 * registry. This list is HAR-detection machinery and deliberately lives here
 * rather than in the `http-extraction` slice: the collector assembles its own
 * descriptor tuple from the same source packages, and the two lists have
 * different members and payloads. Only `fhir-r4` is registered so far; the
 * recognizer specificity ranking (see `fhir-r4-source`'s
 * `FHIR_R4_SPECIFICITY`) reserves seats for the neighbours.
 */
const sources: readonly Source.Source<FhirResource>[] = [fhirR4Source]

export { sources }
