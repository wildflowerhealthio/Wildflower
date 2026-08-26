import { Option } from 'effect'
import type { Extraction, Recognizer } from 'http-extraction-fundamentals'

import { fhirR4ResponseKinds } from './plan-entities.ts'

/**
 * How FHIR R4 traffic is recognized: {@link fhirRootOf} reads the FHIR root
 * off a single URL, and {@link fhirR4Recognizer} claims a response set for the
 * FHIR R4 source when any URL matches an entity pattern. This package owns
 * "what a FHIR R4 root is".
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
 * This is the identity every imported resource is keyed under: the "bit before
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

/** Does any of the shared response kinds claim this URL by its pattern? */
const matchesFhirEntityPattern = (url: string): boolean =>
  fhirR4ResponseKinds.some((responseKind) => responseKind.isFoundAt(url))

/**
 * Where FHIR R4 sits in the recognizer specificity ranking.
 *
 * @remarks
 * The intended order across sources is portal-specific above
 * protocol-generic above catch-all recorder — **Rexall (a named patient
 * portal) > FHIR R4 > web-trace (claims everything)** — so a Rexall archive is
 * never mistaken for a bare FHIR server, and a catch-all recorder only wins
 * when nothing decodes the traffic. A middle integer with room on both sides so
 * a future portal or a second protocol slots in without renumbering. Only the
 * FHIR R4 recognizer is registered so far; the neighbours name the ranking it
 * reserves a seat in.
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
 * separates this from a portal-specific source, not a stricter predicate.
 */
const fhirR4Recognizer: Recognizer.Recognizer = {
  name: 'fhir-r4',
  specificity: FHIR_R4_SPECIFICITY,
  claims: (responses: readonly Extraction.Input[]): boolean =>
    responses.some((response) => matchesFhirEntityPattern(response.url)),
}

export { fhirR4Recognizer, fhirRootOf }
