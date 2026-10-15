import { RegExp as EffectRegExp } from 'effect'
import { HOST_PLACEHOLDER, redactableHostname } from './anonymize-url.ts'

/**
 * Replaces the hosts that name a user's server wherever they stand in text:
 * every relay tunnel (`*.relay.wildflowerhealth.io`), and the hosts the app
 * is known to use, such as its FHIR server and its own origin. Unlike
 * `anonymizeUrl` it leaves the rest of the text as written, so a stack
 * frame's script URL keeps the path and file name of its bundle.
 */

/**
 * A run of hostname labels each followed by a dot: the subdomains in front of
 * a matched host, which are replaced with it.
 */
const SUBDOMAIN_LABELS = '(?:[a-z0-9-]+\\.)'

/**
 * Not preceded by a label character, so a match starts on a label boundary:
 * `ruth.example` does not match inside `xruth.example`, and does in
 * `.ruth.example`. A label character that ends an escape counts as a
 * boundary too: a percent-encoded octet, encoded again any number of times
 * (`%2F`, `%252F`), a `\u` escape (`\u002F`) or a backslash escape (`\n`),
 * so `https%3A%2F%2Fruth.example` matches; a match never starts on a
 * percent-encoded octet's hex digits.
 */
const LABEL_START =
  '(?:(?<![a-z0-9-])|(?<=%(?:25)*[0-9a-f]{2}|\\\\u[0-9a-f]{4}|\\\\[a-z]))' +
  '(?!(?<=%)[0-9a-f]{2})(?!(?<=%[0-9a-f])[0-9a-f])'

/**
 * Not followed by a label character, so a match ends on a label boundary:
 * `ruth.example` does not match the start of `ruth.examples`. A dot does end
 * one, so `ruth.example.status` and a sentence run on without a space
 * (`ruth.example.Retrying`) redact to `{host}.status` and `{host}.Retrying`;
 * so does a longer host such as `ruth.example.org`, which errs towards
 * replacing too much.
 */
const LABEL_END = '(?![a-z0-9-])'

/** An optional port, replaced along with the host. */
const OPTIONAL_PORT = '(?::\\d+)?'

/** A port, which marks a single-label host standing on its own as one. */
const PORT = ':\\d+'

/**
 * Preceded by what starts a URL's authority: `//`, JSON-escaped (`\\/\\/`) or
 * percent-encoded any number of times (`%2F%2F`, `%252F%252F`), or by the
 * `@` that ends its credentials, encoded or not.
 */
const AFTER_AUTHORITY_START = '(?<=//|\\\\/\\\\/|%(?:25)*2f%(?:25)*2f|@|%(?:25)*40)'

/**
 * Every subdomain of the relay, at any depth: a relay tunnel is named after
 * the server it carries. The relay's own host is not one.
 */
const RELAY_TUNNEL_HOSTS = `${SUBDOMAIN_LABELS}+relay\\.wildflowerhealth\\.io`

/**
 * Whether `hostname` is a single label (`fhir`, a docker-compose service
 * name), which is an ordinary word too.
 */
const isSingleLabel = (hostname: string): boolean => /^[a-z0-9-]+$/.test(hostname)

/** A regular expression alternation of `hostnames`, each escaped. */
const alternationOf = (hostnames: readonly string[]): string =>
  `(?:${hostnames.map(EffectRegExp.escape).join('|')})`

/** Replaces the server hosts in a text with `{host}` (see {@link makeHostRedactor}). */
type HostRedactor = (text: string) => string

/**
 * A function that replaces every relay tunnel host, and every one of
 * `hostsToRedact`, in a text with {@link HOST_PLACEHOLDER}.
 *
 * @param hostsToRedact - Hosts (with or without a port) or `http(s)` URLs
 *   the app is known to use; kept hosts and input that names no host (a path
 *   such as `/fhir`) are ignored
 *
 * @remarks
 * Hosts are matched case-insensitively, on label boundaries, with any
 * subdomains in front of them and any port after them, all of which the
 * placeholder replaces: with `ruth.example` to redact,
 * `https://API.Ruth.Example:8443/x` becomes `https://{host}/x`, while
 * `xruth.example` stays. Longer hosts are tried first.
 *
 * A single-label host (`fhir`) is an ordinary word too, so it is replaced only
 * where it reads as a host: at the start of a URL's authority
 * (`http://fhir:8080/x`, `user@fhir`) or with a port (`fhir:8080`). The word
 * alone (`FHIR R4`) and identifiers built on it (`fhir_server_host`) stay.
 *
 * Idempotent: a redacted text redacts to itself.
 */
const makeHostRedactor = (hostsToRedact: Iterable<string>): HostRedactor => {
  const knownHostnames = [
    ...new Set([...hostsToRedact].flatMap((host) => redactableHostname(host) ?? [])),
  ].toSorted((left, right) => right.length - left.length)
  const multiLabelHostnames = knownHostnames.filter((hostname) => !isSingleLabel(hostname))
  const singleLabelHostnames = knownHostnames.filter(isSingleLabel)
  const multiLabelHosts = [
    RELAY_TUNNEL_HOSTS,
    ...(multiLabelHostnames.length === 0
      ? []
      : [`${SUBDOMAIN_LABELS}*${alternationOf(multiLabelHostnames)}`]),
  ]
  const hostMatches = [
    `${LABEL_START}(?:${multiLabelHosts.join('|')})${OPTIONAL_PORT}`,
    ...(singleLabelHostnames.length === 0
      ? []
      : [
          `${AFTER_AUTHORITY_START}${alternationOf(singleLabelHostnames)}${OPTIONAL_PORT}`,
          `${LABEL_START}${alternationOf(singleLabelHostnames)}${PORT}`,
        ]),
  ]
  const hosts = new RegExp(`(?:${hostMatches.join('|')})${LABEL_END}`, 'gi')
  return (text) => text.replace(hosts, HOST_PLACEHOLDER)
}

export type { HostRedactor }
export { makeHostRedactor }
