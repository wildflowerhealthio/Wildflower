import { EntityDefinition } from 'collector-fundamentals/model'
import type { Recognizer, Replay } from 'collector-fundamentals/replay'
import { Effect, Option } from 'effect'
import { adoptResource } from 'fhir-r4/identity'
import type { FhirResource } from 'fhir-r4/resources'

import { fhirR4EntityDefinitions } from './plan-entities.ts'

/**
 * The offline extraction surface for the FHIR R4 collector — the seam an
 * archive importer drives when there is no live sniffer.
 *
 * @remarks
 * Everything here reads the *same* evidence the live collector does: the shared
 * `fhirR4EntityDefinitions` tuple (`./plan-entities.ts`) for the decode, and a
 * URL's own path for its identity. {@link offlineEntities} decodes through that
 * tuple and keys each resource under **the root of the URL it arrived on** —
 * `fhirRootOf(response.url)` — rather than one system chosen for the whole
 * capture. {@link fhirR4Recognizer} claims a response set by the tuple's URL
 * patterns, and {@link fhirRootOf} is the per-URL primitive both build on. This
 * package owns "what a FHIR R4 root is".
 *
 * A resource is keyed under its own URL's root, so a capture that reached two
 * servers keys each server's resources apart with no inference or voting. The
 * cost, accepted deliberately: a relative reference (`Patient/x` on an
 * `Observation`) is rewritten under that resource's *own* root, so a genuine
 * cross-server reference — one server's resource pointing at another's — dangles.
 * That is FHIR-correct (cross-server references are meant to be absolute) and no
 * worse than the live path, where every resource shares one configured root.
 */

/**
 * Capture the FHIR root — authority plus any base path — that precedes a
 * `/Patient/<id>`, `/Observation/<id>`, or `/Observation?…` segment. The
 * base-path group is non-greedy for the same reason `UrlMatch` builds its
 * predicate that way: the *shortest* base path that still lets the resource
 * segment match wins, so a server mounted under `/baseR4` or
 * `/interconnect-fhir-oauth/api/FHIR/R4` recovers its full root. Anchored to
 * `https?://` because a FHIR root has to be a URL a `SourceIdentity` can key
 * under, which a non-HTTP scheme is not.
 */
const PATIENT_ROOT = /^(https?:\/\/[^/]+(?:\/[^/?#]+)*?)\/Patient\/[^/?#]+(?:\?|$)/
const OBSERVATION_ROOT = /^(https?:\/\/[^/]+(?:\/[^/?#]+)*?)\/Observation(?:\/[^/?#]+(?:\?|$)|\?)/

/**
 * The FHIR root a single URL was served from — the prefix before its
 * `/Patient/<id>`, `/Observation/<id>`, or `/Observation?…` segment.
 *
 * @param url - A response URL
 * @returns The root, or `Option.none()` when the URL names no FHIR resource
 *   (or is not `http(s)`)
 *
 * @remarks
 * This is the identity every offline resource is keyed under: the "bit before
 * `/Patient/:id`" a capture makes directly available, so there is nothing to
 * infer across a whole capture. Base-path tolerant the same way `UrlMatch`'s
 * `isFoundAt` is, so `https://ehr/baseR4/Patient/1` and
 * `https://ehr/fhir/R4/Observation/2` recover `https://ehr/baseR4` and
 * `https://ehr/fhir/R4` respectively.
 */
const fhirRootOf = (url: string): Option.Option<string> => {
  const match = PATIENT_ROOT.exec(url) ?? OBSERVATION_ROOT.exec(url)
  return match?.[1] === undefined ? Option.none() : Option.some(match[1])
}

/**
 * Wrap an entity so its `parse` output is adopted under the root of the URL the
 * response arrived on, rather than a single pre-chosen source.
 *
 * @remarks
 * The decode is the shared entity's, untouched — only the adoption source
 * changes, and it is read per response from `response.url`. `adoptResource`
 * (from `fhir-r4/identity`, the same derivation the live plan's
 * `adoptSourceIdentity` applies) re-keys each resource under
 * `{ system: root, baseUrl: root }`, so an offline resource captured from a
 * given root carries the byte-identical local id the live plan gives it when
 * `config.rootUrl` is that root.
 *
 * A response whose URL yields no root ({@link fhirRootOf} is `None`) can only be
 * a non-`http(s)` URL that still matched the scheme-agnostic `isFoundAt` — a
 * real FHIR capture has none — so its resources pass through un-adopted rather
 * than being dropped; the decode itself already succeeded.
 */
const adoptedUnderResponseRoot = (
  entity: EntityDefinition.EntityDefinition<FhirResource>
): EntityDefinition.EntityDefinition<FhirResource> =>
  EntityDefinition.make({
    name: entity.name,
    isFoundAt: entity.isFoundAt,
    parse: (response) =>
      Effect.map(entity.parse(response), (resources) => {
        const root = fhirRootOf(response.url)
        if (Option.isNone(root)) return resources
        const adopt = adoptResource({ system: root.value, baseUrl: root.value })
        return resources.map((resource) => adopt(resource))
      }),
  })

/**
 * The FHIR R4 entities for offline replay: the shared tuple's decode, with each
 * resource keyed under the root of the URL it arrived on.
 *
 * @remarks
 * Reuses `fhirR4EntityDefinitions` for the decode — the same single definition
 * the live plan consumes — so a resource decodes identically whether it arrives
 * through the sniffer or an archive; only the identity source differs (the live
 * plan keys under `config.rootUrl`, this keys under each response's own root,
 * and the two coincide for a capture from that server). Feed the result
 * straight to `Replay.replayEntities`.
 *
 * A module-level constant, not a factory: identity is resolved per response
 * inside `parse`, so there is nothing to parameterize and the array is stable.
 * The entities alone — no plan, no `stepSequence`, no `captureProvenance`:
 * offline replay navigates nothing, and its provenance is the source archive
 * linked once, not a per-response trace.
 */
const offlineEntities: readonly EntityDefinition.EntityDefinition<FhirResource>[] =
  fhirR4EntityDefinitions.map(adoptedUnderResponseRoot)

/** Does any of the shared entities claim this URL by its pattern? */
const matchesFhirEntityPattern = (url: string): boolean =>
  fhirR4EntityDefinitions.some((entity) => entity.isFoundAt(url))

/**
 * Where FHIR R4 sits in the recognizer specificity ranking.
 *
 * @remarks
 * The intended order across this epic's collectors is portal-specific above
 * protocol-generic above catch-all recorder — **Rexall (a named patient
 * portal) > FHIR R4 > web-trace (claims everything)** — so a Rexall archive is
 * never mistaken for a bare FHIR server, and the web-trace recorder only wins
 * when nothing decodes the traffic. A middle integer with room on both sides so
 * a future portal or a second protocol slots in without renumbering. Only the
 * FHIR R4 recognizer is registered this epic; the neighbours name the ranking
 * it reserves a seat in.
 */
const FHIR_R4_SPECIFICITY = 50

/**
 * Recognizes a response set as FHIR R4 traffic with no user configuration.
 *
 * @remarks
 * Claims when *any* response URL matches one of the three FHIR entity patterns
 * (`…/Patient/<id>`, `…/Observation/<id>`, `…/Observation?…`), reusing the
 * shared entities' own `isFoundAt` so the recognizer and the entities it speaks
 * for can never disagree on what a FHIR URL is. A single URL match is enough:
 * the patterns are specific to the FHIR resource tree, so HTML portal traffic
 * and arbitrary JSON APIs — which carry no such path — decline, while both our
 * own capture shape and a browser's HAR export of a FHIR server claim.
 *
 * URL-only by design: the payload is not decoded here. Body inspection would
 * only ever *strengthen* an already-claiming URL match, and the specificity
 * ranking `Recognizer.resolve` reads (see {@link FHIR_R4_SPECIFICITY}) is what
 * separates this from a portal-specific collector, not a stricter predicate.
 */
const fhirR4Recognizer: Recognizer.Recognizer = {
  name: 'fhir-r4',
  specificity: FHIR_R4_SPECIFICITY,
  claims: (responses: readonly Replay.ReplayResponse[]): boolean =>
    responses.some((response) => matchesFhirEntityPattern(response.url)),
}

export { fhirR4Recognizer, fhirRootOf, offlineEntities }
