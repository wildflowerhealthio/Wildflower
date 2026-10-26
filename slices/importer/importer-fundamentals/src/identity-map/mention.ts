/**
 * A mention: each place a resource names something by a `Reference`, at its
 * path, and where it lands.
 *
 * @remarks
 * Mentions are found by `fhir-r4`'s `ResourceReferences` walk, so a reference
 * anywhere in a resource is one: a `subject`, a `requester`, a `performer`
 * of whichever shape its type gives it, a `DiagnosticReport.resultsInterpreter`,
 * a note's `authorReference`. Which type an identifier-only mention names is
 * the reference's own business: a logical reference states its `type`
 * (`LinkableLogicalReference.tryFromReference`), and one that does not names nothing.
 *
 * @packageDocumentation
 */

import type { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import { type FhirResource, ResourceReferences } from '@wildflowerhealthio/fhir-r4/resources'

/**
 * One mention: the reference as the resource carries it (its literal
 * reference, identifier, `type` and `display`) and its path in the resource,
 * `subject`, `performer[0].actor`, which is what an unlinked mention reports.
 * The mentioning resource is not among them, since every reader already holds
 * it.
 */
type Type = ResourceReferences.ReferenceAt

/** Every mention in `resource`, in the walk's order. */
const of = (resource: FhirResource): readonly Type[] => ResourceReferences.collect(resource)

/**
 * A relative literal reference, `Type/<id>` with an optional
 * `/_history/<version>`: FHIR's literal reference grammar
 * (https://hl7.org/fhir/R4/references.html#literal) without the base URL,
 * its type and id under FHIR's own patterns.
 */
const RELATIVE_LITERAL_REFERENCE =
  /^[A-Z][A-Za-z]+\/[A-Za-z0-9\-.]{1,64}(\/_history\/[A-Za-z0-9\-.]{1,64})?$/

/**
 * Whether a reference lands on a record of the device: a relative literal
 * reference, `Type/<id>`, as opposed to none, an absolute URL into another
 * system, a contained `#<id>`, or text that is no reference at all.
 */
const landsOnDevice = (reference: IdentifierAndReference.ReferenceType): boolean =>
  reference.reference !== null && RELATIVE_LITERAL_REFERENCE.test(reference.reference)

export { landsOnDevice, of }
export type { Type }
