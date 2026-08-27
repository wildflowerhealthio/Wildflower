import { adoptUnderRecognizedRoot } from 'fhir-r4/identity'
import type { FhirResource } from 'fhir-r4/resources'
import type { HttpResponseKind } from 'http-extraction-fundamentals'

import { fhirR4ResponseKinds } from './plan-entities.ts'

/**
 * The FHIR R4 source's entities: the shared `fhirR4ResponseKinds` tuple's
 * decode, with each resource keyed under the root of the URL it arrived on.
 *
 * @remarks
 * `adoptUnderRecognizedRoot` (from `fhir-r4/identity`) wraps each kind so its
 * `parse` output is adopted under the identity **the kind's own `tryRecognize`
 * mints for the response's URL** — `{ system: root, baseUrl: root }`, the root
 * the fused matcher captured. So a resource imported from a given root carries
 * the byte-identical local id the live plan gives it when `config.rootUrl` is
 * that root; the same one combinator serves both live and archive, with the
 * identity read per response rather than passed in.
 *
 * A resource is keyed under its own URL's root, so a capture that reached two
 * servers keys each server's resources apart with no inference or voting. The
 * cost, accepted deliberately: a relative reference (`Patient/x` on an
 * `Observation`) is rewritten under that resource's *own* root, so a genuine
 * cross-server reference — one server's resource pointing at another's —
 * dangles. That is FHIR-correct (cross-server references are meant to be
 * absolute).
 *
 * Reuses `fhirR4ResponseKinds` for the decode — the same single definition the
 * live plan consumes — so a resource decodes identically whether it arrives
 * through a sniffer or an archive; only the identity source differs (the live
 * plan keys under `config.rootUrl`, this keys under each response's own root,
 * and the two coincide for a capture from that server). Feed the result
 * straight to `Extraction.run`.
 *
 * A module-level constant, not a factory: `adoptUnderRecognizedRoot` takes no
 * source parameter (identity is resolved per response inside `parse`), so there
 * is nothing to parameterize and the array is stable by identity. The entities
 * alone — no plan, no `stepSequence`, no `captureProvenance`: extraction
 * navigates nothing, and an archive-driven consumer's provenance is its source
 * archive linked once, not a per-response trace. The per-kind
 * `EntityParsesEveryResource` guard needs the wide `HttpResponseKind<FhirResource>`
 * element type, which `fhirR4ResponseKinds` already carries.
 */
const fhirR4SourceEntities: readonly HttpResponseKind.HttpResponseKind<FhirResource>[] =
  fhirR4ResponseKinds.map(adoptUnderRecognizedRoot)

export { fhirR4SourceEntities }
