import { Effect, Option } from 'effect'
import { adoptResource } from 'fhir-r4/identity'
import type { FhirResource } from 'fhir-r4/resources'
import { HttpResponseKind } from 'http-extraction-fundamentals'

import { fhirR4ResponseKinds } from './plan-entities.ts'
import { fhirRootOf } from './root.ts'

/**
 * The entities the FHIR R4 source extracts a set of responses with: the shared
 * `fhirR4ResponseKinds` tuple's decode, keying each resource under the
 * root of the URL it arrived on.
 *
 * @remarks
 * Everything here reads the same evidence as the shared tuple
 * (`./plan-entities.ts`): the tuple for the decode, and a URL's own path for
 * its identity. {@link fhirR4SourceEntities} decodes through that tuple and
 * keys each resource under **the root of the URL it arrived on** —
 * `fhirRootOf(response.url)` — rather than one system chosen for the whole
 * capture.
 *
 * A resource is keyed under its own URL's root, so a capture that reached two
 * servers keys each server's resources apart with no inference or voting. The
 * cost, accepted deliberately: a relative reference (`Patient/x` on an
 * `Observation`) is rewritten under that resource's *own* root, so a genuine
 * cross-server reference — one server's resource pointing at another's — dangles.
 * That is FHIR-correct (cross-server references are meant to be absolute).
 */

/**
 * Wrap a response kind so its `parse` output is adopted under the root of the
 * URL the response arrived on, rather than a single pre-chosen source.
 *
 * @remarks
 * The decode is the shared response kind's, untouched — only the adoption
 * source changes, and it is read per response from `response.url`.
 * `adoptResource` (from `fhir-r4/identity`, the same derivation the live
 * plan's `adoptSourceIdentity` applies) re-keys each resource under
 * `{ system: root, baseUrl: root }`, so a resource imported from a given root
 * carries the byte-identical local id the live plan gives it when
 * `config.rootUrl` is that root.
 *
 * A response whose URL yields no root ({@link fhirRootOf} is `None`) can only be
 * a non-`http(s)` URL that still matched the scheme-agnostic `isFoundAt` — a
 * real FHIR capture has none — so its resources pass through un-adopted rather
 * than being dropped; the decode itself already succeeded.
 */
const adoptedUnderResponseRoot = (
  responseKind: HttpResponseKind.HttpResponseKind<FhirResource>
): HttpResponseKind.HttpResponseKind<FhirResource> =>
  HttpResponseKind.make({
    name: responseKind.name,
    isFoundAt: responseKind.isFoundAt,
    parse: (response) =>
      Effect.map(responseKind.parse(response), (resources) => {
        const root = fhirRootOf(response.url)
        if (Option.isNone(root)) return resources
        const adopt = adoptResource({ system: root.value, baseUrl: root.value })
        return resources.map((resource) => adopt(resource))
      }),
  })

/**
 * The FHIR R4 source's entities: the shared tuple's decode, with each
 * resource keyed under the root of the URL it arrived on.
 *
 * @remarks
 * Reuses `fhirR4ResponseKinds` for the decode — the same single definition
 * the live plan consumes — so a resource decodes identically whether it arrives
 * through a sniffer or an archive; only the identity source differs (the live
 * plan keys under `config.rootUrl`, this keys under each response's own root,
 * and the two coincide for a capture from that server). Feed the result
 * straight to `Extraction.run`.
 *
 * A module-level constant, not a factory: identity is resolved per response
 * inside `parse`, so there is nothing to parameterize and the array is stable.
 * The entities alone — no plan, no `stepSequence`, no `captureProvenance`:
 * extraction navigates nothing, and an archive-driven consumer's provenance
 * is its source archive linked once, not a per-response trace.
 */
const fhirR4SourceEntities: readonly HttpResponseKind.HttpResponseKind<FhirResource>[] =
  fhirR4ResponseKinds.map(adoptedUnderResponseRoot)

export { fhirR4SourceEntities }
