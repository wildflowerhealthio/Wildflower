import { anonymizeHost, HOST_PLACEHOLDER } from './anonymize-url.ts'

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
 * Not preceded by a hostname character, so a match starts on a label
 * boundary: `ruth.example` does not match inside `xruth.example`.
 */
const LABEL_START = '(?<![a-z0-9.-])'

/**
 * Not followed by a hostname character, or by a dot and one, so a match ends
 * on the host's last label: `ruth.example` does not match the start of
 * `ruth.example.org`, while a sentence's closing dot still ends one.
 */
const LABEL_END = '(?!\\.?[a-z0-9-])'

/** An optional port, replaced along with the host. */
const OPTIONAL_PORT = '(?::\\d+)?'

/**
 * Every subdomain of the relay, at any depth: a relay tunnel is named after
 * the server it carries. The relay's own host is not one.
 */
const RELAY_TUNNEL_HOSTS = `${SUBDOMAIN_LABELS}+relay\\.wildflowerhealth\\.io`

/** `text` with every character a regular expression reads as syntax escaped. */
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The hostname of `host` (a host with an optional port, or an `http(s)`
 * origin) as the URL parser reads it, lower-cased; `undefined` for input it
 * rejects and for a kept host (`localhost`, `tauri.localhost`,
 * `wildflowerhealth.io`), which telemetry reports as written.
 */
const redactableHostname = (host: string): string | undefined => {
  if (!anonymizeHost(host).endsWith(HOST_PLACEHOLDER)) return undefined
  const origin = URL.parse(/^https?:/i.test(host) ? host : `http://${host}`)
  return origin === null || origin.hostname === '' ? undefined : origin.hostname
}

/**
 * A function that replaces every relay tunnel host, and every one of
 * `hostsToRedact`, in a text with {@link HOST_PLACEHOLDER}.
 *
 * @param hostsToRedact - Hosts (with or without a port) or `http(s)` origins
 *   the app is known to use; kept hosts and input the URL parser rejects are
 *   ignored
 *
 * @remarks
 * Hosts are matched case-insensitively, on label boundaries, with any
 * subdomains in front of them and any port after them, all of which the
 * placeholder replaces: with `ruth.example` to redact,
 * `https://API.Ruth.Example:8443/x` becomes `https://{host}/x`, while
 * `xruth.example.org` stays. Longer hosts are tried first.
 *
 * Idempotent: a redacted text redacts to itself.
 */
const makeHostRedactor = (hostsToRedact: Iterable<string>): ((text: string) => string) => {
  const knownHostnames = [
    ...new Set([...hostsToRedact].flatMap((host) => redactableHostname(host) ?? [])),
  ].toSorted((left, right) => right.length - left.length)
  const knownHosts =
    knownHostnames.length === 0
      ? []
      : [`${SUBDOMAIN_LABELS}*(?:${knownHostnames.map(escapeRegExp).join('|')})`]
  const hosts = new RegExp(
    `${LABEL_START}(?:${[RELAY_TUNNEL_HOSTS, ...knownHosts].join('|')})${OPTIONAL_PORT}${LABEL_END}`,
    'gi'
  )
  return (text) => text.replace(hosts, HOST_PLACEHOLDER)
}

export { makeHostRedactor }
