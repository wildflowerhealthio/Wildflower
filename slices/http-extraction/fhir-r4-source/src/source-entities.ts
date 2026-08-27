import { adoptUnderRecognizedRoot } from 'fhir-r4/identity'
import type { FhirResource } from 'fhir-r4/resources'
import type { HttpResponseKind } from 'http-extraction-fundamentals'

import { fhirR4ResponseKinds } from './plan-entities.ts'

/**
 * The FHIR R4 source's entities: the shared `fhirR4ResponseKinds` tuple's
 * decode, each kind adopted so its resources key under the root **its own
 * `tryRecognize` mints for the response's URL** — the one definition both the
 * live plan and an archive import consume, by reference.
 *
 * @remarks
 * Per-URL keying keeps a two-server capture's resources apart with no
 * inference; the accepted cost is that a rewritten relative reference dangles
 * across servers (FHIR-correct — cross-server references are meant to be
 * absolute). Design and consequences:
 * `slices/collector/docs/Source Identity Explanation.md`. A module-level
 * constant, not a factory — the combinator takes no source parameter, so the
 * array is stable by identity, which is what the config deep-equal suites and
 * the live==archive reference-identity parity rest on.
 */
const fhirR4SourceEntities: readonly HttpResponseKind.HttpResponseKind<FhirResource>[] =
  fhirR4ResponseKinds.map(adoptUnderRecognizedRoot)

export { fhirR4SourceEntities }
