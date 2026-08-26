import type { FhirResource } from 'fhir-r4/resources'
import type { Importer } from 'importer-fundamentals'

import { fhirR4ImporterEntities } from './importer-entities.ts'
import { fhirR4Recognizer, fhirRootOf } from './recognizer.ts'

/**
 * The FHIR R4 importer, assembled as one first-class value.
 *
 * @remarks
 * Spreads {@link fhirR4Recognizer} for its `name`/`specificity`/`claims`, then
 * adds the import-side fields. `tag` is the literal `'fhir-r4'`, the
 * discriminator a preview reports as `importerTag`; `rootOf` is
 * {@link fhirRootOf}, the per-URL root primitive the entities key on, so a
 * pipeline reads a source root exactly the way the entities do. The entities
 * are archive-independent, so `entitiesFor` ignores its argument and returns
 * the module-level constant.
 */
const fhirR4Importer: Importer.Importer<FhirResource> = {
  ...fhirR4Recognizer,
  tag: 'fhir-r4',
  entitiesFor: () => fhirR4ImporterEntities,
  rootOf: fhirRootOf,
}

export { fhirR4Importer }
