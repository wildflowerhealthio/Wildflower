import { Option } from 'effect'

/**
 * The per-URL FHIR root primitive. This package owns "what a FHIR R4 root is",
 * and both consumers of that answer read it through {@link fhirRootOf}: the
 * assembled `fhirR4Source`'s `rootOf`, and the source response kinds' per-URL
 * keying. Its own leaf module so those two can import it without either
 * depending on the other.
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

export { fhirRootOf }
