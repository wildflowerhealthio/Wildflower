import type { EntityDefinition } from 'collector-fundamentals/model'
import type { Recognizer, Replay } from 'collector-fundamentals/replay'
import { Option } from 'effect'
import { adoptSourceIdentity } from 'fhir-r4/identity'
import type { FhirResource } from 'fhir-r4/resources'

import { fhirR4EntityDefinitions } from './plan-entities.ts'

/**
 * The offline extraction surface for the FHIR R4 collector — the seam an
 * archive importer drives when there is no live sniffer.
 *
 * @remarks
 * Three exports, all reading the *same* evidence the live collector does: the
 * shared `fhirR4EntityDefinitions` tuple (`./plan-entities.ts`). {@link
 * offlineEntities} adopts that tuple for a root so a resource re-keys exactly
 * as the live plan re-keys it; {@link fhirR4Recognizer} claims a response set
 * by that tuple's URL patterns; {@link inferFhirRootUrl} reads the configured
 * root back off those same URLs. This package owns "what a FHIR R4 root is",
 * so both the recognizer and the inference derive it here rather than in a
 * downstream importer.
 */

/**
 * The source identity a FHIR R4 archive's resources are adopted under, matching
 * the live plan's exactly: `system` and `baseUrl` are both the configured root,
 * so a server that spells its self-references absolutely rewrites them the same
 * as relative ones.
 */
const sourceFor = (rootUrl: string): { readonly system: string; readonly baseUrl: string } => ({
  system: rootUrl,
  baseUrl: rootUrl,
})

/**
 * The FHIR R4 entities re-keyed to `rootUrl`, ready to fold a static response
 * set through offline.
 *
 * @param rootUrl - The configured FHIR server root the archive was captured
 *   from; the namespace every parsed resource is adopted into
 * @returns The three entities (Patient, Observation, Observation-list) in plan
 *   order, each with its `parse` wrapped by `adoptSourceIdentity({ system:
 *   rootUrl, baseUrl: rootUrl })`
 *
 * @remarks
 * The same `adoptSourceIdentity` call the live `scrapingPlan` makes, over the
 * same shared `fhirR4EntityDefinitions` tuple — so for a given `rootUrl` the
 * returned entities deep-equal the live plan's `entityDefinitions`, and a
 * resource parsed here carries the byte-identical local id it would carry live.
 * That equality is referential where it counts: `adoptSourceIdentity` memoizes
 * one wrapped `parse` per `(source, entity)`, so both surfaces name the same
 * decode function rather than two closures that merely behave alike.
 *
 * Just the entities come back — no plan, no `stepSequence`, and no
 * `captureProvenance`. An offline import performs no navigation, and its
 * provenance is the source archive linked once, not a per-response trace, so
 * neither has any offline meaning. Feed the result straight to
 * `Replay.replayEntities`.
 */
const offlineEntities = (
  rootUrl: string
): readonly EntityDefinition.EntityDefinition<FhirResource>[] =>
  adoptSourceIdentity(sourceFor(rootUrl))({ entityDefinitions: fhirR4EntityDefinitions })
    .entityDefinitions

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

/** The FHIR root a single URL was served from, if it names a FHIR resource. */
const rootOf = (url: string): Option.Option<string> => {
  const match = PATIENT_ROOT.exec(url) ?? OBSERVATION_ROOT.exec(url)
  return match?.[1] === undefined ? Option.none() : Option.some(match[1])
}

/**
 * Infer the FHIR R4 server root a set of URLs was captured from.
 *
 * @param urls - The response URLs of a capture, in the order they were seen
 * @returns The inferred root, or `Option.none()` when no URL names a FHIR
 *   resource
 *
 * @remarks
 * Filters to the URLs the shared entities claim (reusing their `isFoundAt`, the
 * one source of truth for a FHIR URL), then derives each one's root: the prefix
 * preceding its matched `/Patient` or `/Observation` segment, honoring an
 * arbitrary base path. A claimed URL that is not `http(s)` yields no root and is
 * dropped, because it could not be a configurable root anyway.
 *
 * When the derived roots disagree — a capture that reached more than one server
 * — the **most frequent** wins, and a frequency tie breaks toward the root whose
 * first occurrence is earliest in `urls`. Disagreement means the archive is not
 * a clean single-server capture; picking the plurality keeps a stray
 * cross-origin request from derailing an otherwise-consistent one, and the
 * earliest-first tie-break keeps the result a deterministic function of input
 * order.
 */
const inferFhirRootUrl = (urls: readonly string[]): Option.Option<string> => {
  const roots: string[] = []
  for (const url of urls) {
    if (!matchesFhirEntityPattern(url)) continue
    const root = rootOf(url)
    if (Option.isSome(root)) roots.push(root.value)
  }

  const [firstRoot] = roots
  if (firstRoot === undefined) return Option.none()

  const counts = new Map<string, number>()
  for (const root of roots) counts.set(root, (counts.get(root) ?? 0) + 1)

  // Walk the roots in first-occurrence order, replacing the incumbent only on a
  // strictly greater count, so a tie keeps the earliest-seen root.
  let best = firstRoot
  let bestCount = counts.get(firstRoot) ?? 0
  const considered = new Set<string>([firstRoot])
  for (const root of roots) {
    if (considered.has(root)) continue
    considered.add(root)
    const count = counts.get(root) ?? 0
    if (count > bestCount) {
      best = root
      bestCount = count
    }
  }

  return Option.some(best)
}

export { fhirR4Recognizer, inferFhirRootUrl, offlineEntities }
