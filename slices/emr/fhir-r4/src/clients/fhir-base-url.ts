/**
 * `fhirBaseUrl` with its trailing slashes trimmed, so a base-relative FHIR path
 * appends to it cleanly.
 *
 * @param fhirBaseUrl - A FHIR server base as a user or a SMART handshake named
 *   it, e.g. `https://fhir.example/r4/`
 * @returns The same base with every trailing `/` removed, e.g.
 *   `https://fhir.example/r4`
 *
 * @remarks
 * The typed client (`FhirR4ResourcesHttpApiClient`) emits base-relative
 * paths with a leading slash (`/Patient`), and a provider prepends the server's
 * base to them. A base entered with a trailing slash would otherwise address
 * `…/r4//Patient`. Everything that joins a path to a FHIR base — the SMART HTTP
 * layer, the well-known probe, a hand-off that gives the base to another
 * client — trims it by this one rule, so they all address the server alike.
 * Nothing else is normalised: the base is otherwise used verbatim.
 */
const trimTrailingSlashes = (fhirBaseUrl: string): string => fhirBaseUrl.replace(/\/+$/u, '')

export { trimTrailingSlashes }
