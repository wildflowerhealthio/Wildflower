import type { FhirResource } from 'fhir-r4/resources'
import type { Extraction, Source } from 'http-extraction-fundamentals'

import { fhirR4ResponseKinds } from './plan-entities.ts'
import { fhirRootOf } from './root.ts'
import { fhirR4SourceEntities } from './source-entities.ts'

/** Does any of the shared response kinds claim this URL by its pattern? */
const matchesFhirEntityPattern = (url: string): boolean =>
  fhirR4ResponseKinds.some((responseKind) => responseKind.isFoundAt(url))

/**
 * Where FHIR R4 sits in the source specificity ranking.
 *
 * @remarks
 * The intended order across sources is portal-specific above protocol-generic
 * above catch-all recorder — **Rexall (a named patient portal) > FHIR R4 >
 * web-trace (claims everything)** — so a Rexall archive is never mistaken for a
 * bare FHIR server, and a catch-all recorder only wins when nothing decodes the
 * traffic. A middle integer with room on both sides so a future portal or a
 * second protocol slots in without renumbering. Only the FHIR R4 source is
 * registered so far; the neighbours name the ranking it reserves a seat in.
 */
const FHIR_R4_SPECIFICITY = 50

/**
 * The FHIR R4 source, assembled as one first-class value.
 *
 * @remarks
 * Recognition is URL-only and lives right on the value: `claims` is true when
 * *any* response URL matches one of the three FHIR entity patterns
 * (`…/Patient/<id>`, `…/Observation/<id>`, `…/Observation?…`), reusing the
 * shared response kinds' own `isFoundAt` (via {@link matchesFhirEntityPattern})
 * so the source's claim and the response kinds it speaks for can never disagree
 * on what a FHIR URL is. A single URL match is enough: the patterns are
 * specific to the FHIR resource tree, so HTML portal traffic and arbitrary JSON
 * APIs — which carry no such path — decline, while both our own capture shape
 * and a browser's HAR export of a FHIR server claim. The payload is not decoded
 * to recognize: body inspection would only ever *strengthen* an already-claiming
 * URL match, and {@link FHIR_R4_SPECIFICITY} is what separates this from a
 * portal-specific source, not a stricter predicate.
 *
 * The extraction fields ride the same value: `name` (the identifier `resolve`
 * and logs use) and `tag` (the discriminator a consumer reports) are both the
 * literal `'fhir-r4'`; `responseKinds` is the module-level
 * {@link fhirR4SourceEntities}; and `rootOf` is {@link fhirRootOf}, the per-URL
 * root primitive the response kinds key on, so a consumer reads a source root
 * exactly the way the response kinds do.
 */
const fhirR4Source: Source.Source<FhirResource> = {
  name: 'fhir-r4',
  specificity: FHIR_R4_SPECIFICITY,
  claims: (responses: readonly Extraction.Input[]): boolean =>
    responses.some((response) => matchesFhirEntityPattern(response.url)),
  tag: 'fhir-r4',
  responseKinds: fhirR4SourceEntities,
  rootOf: fhirRootOf,
}

export { fhirR4Source }
