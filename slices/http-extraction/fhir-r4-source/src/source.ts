import type { FhirResource } from 'fhir-r4/resources'
import type { Source } from 'http-extraction-fundamentals'

import { fhirR4Recognizer, fhirRootOf } from './recognizer.ts'
import { fhirR4SourceEntities } from './source-entities.ts'

/**
 * The FHIR R4 source, assembled as one first-class value.
 *
 * @remarks
 * Spreads {@link fhirR4Recognizer} for its `name`/`specificity`/`claims`, then
 * adds the extraction-side fields. `tag` is the literal `'fhir-r4'`, the
 * discriminator a consumer reports; `rootOf` is {@link fhirRootOf}, the
 * per-URL root primitive the entities key on, so a consumer reads a source
 * root exactly the way the entities do; `entities` is the module-level
 * {@link fhirR4SourceEntities} constant.
 */
const fhirR4Source: Source.Source<FhirResource> = {
  ...fhirR4Recognizer,
  tag: 'fhir-r4',
  entities: fhirR4SourceEntities,
  rootOf: fhirRootOf,
}

export { fhirR4Source }
