import { createHash } from 'node:crypto'

/**
 * One prebuilt OHIF viewer release: where its archive is and what its bytes
 * hash to. Both come from a release of `wildflowerhealthio/ohif-viewer-dist`,
 * the repository that builds OHIF from source with the FHIR viewer extension
 * linked in.
 */
interface PrebuiltPin {
  /** HTTPS URL of the `ohif-viewer.tar.gz` release asset. */
  readonly url: string
  /** Lower-case hex SHA-256 of that archive's bytes, as the release publishes it. */
  readonly sha256: string
}

/** The parsed `prebuilt.json`: a pin, or `null` while no release is pinned yet. */
type PrebuiltConfig = PrebuiltPin | null

const SHA256_HEX = /^[0-9a-f]{64}$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/**
 * Validates the parsed contents of `prebuilt.json`.
 *
 * @param value - The JSON document, already parsed.
 * @returns The pin, or `null` when the file declares `"pin": null`.
 * @throws Error naming the offending field when the document is not
 *   `{ pin: null }` or `{ pin: { url: <https URL>, sha256: <64 hex chars> } }`.
 *
 * @remarks
 * Strict on purpose: the build downloads and publishes whatever this points
 * at, so a typo in the hash or a non-HTTPS URL fails here rather than
 * producing a site that silently serves an unverified bundle. The hash is
 * normalised to lower case so a release note copied with upper-case hex still
 * compares equal to what {@link sha256Hex} produces.
 */
const parsePrebuiltConfig = (value: unknown): PrebuiltConfig => {
  if (!isRecord(value) || !('pin' in value)) {
    throw new Error('prebuilt.json must be an object with a "pin" field')
  }
  const { pin } = value
  if (pin === null) return null
  if (!isRecord(pin)) throw new Error('prebuilt.json "pin" must be null or an object')
  const { url, sha256 } = pin
  if (typeof url !== 'string' || !isHttpsUrl(url)) {
    throw new Error('prebuilt.json "pin.url" must be an https:// URL')
  }
  if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256.toLowerCase())) {
    throw new Error('prebuilt.json "pin.sha256" must be 64 hex characters')
  }
  return { url, sha256: sha256.toLowerCase() }
}

const isHttpsUrl = (value: string): boolean => {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

/** Lower-case hex SHA-256 of `bytes`, the form {@link PrebuiltPin.sha256} uses. */
const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/**
 * Whether `bytes` are the archive the pin promises.
 *
 * @param pin - The pin whose `sha256` the bytes must match.
 * @param bytes - The downloaded archive.
 * @returns `true` only when {@link sha256Hex} of the bytes equals the pin's hash.
 */
const matchesPin = (pin: PrebuiltPin, bytes: Uint8Array): boolean => sha256Hex(bytes) === pin.sha256

/**
 * The page published in place of the viewer while `prebuilt.json` pins no
 * release. Says so plainly, so a visitor (or a reviewer of a PR preview)
 * sees a deliberate placeholder rather than a broken deploy.
 *
 * @param pinPath - Repo-relative path of the pin file, named in the page so
 *   the reader knows what to edit.
 */
const renderStubPage = (pinPath: string): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>OHIF viewer (not pinned)</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 3rem auto; max-width: 40rem; padding: 0 1rem; }
      code { font-family: ui-monospace, monospace; }
    </style>
  </head>
  <body>
    <h1>OHIF viewer is not pinned yet</h1>
    <p>
      This section publishes a prebuilt OHIF viewer, but <code>${escapeHtml(pinPath)}</code>
      currently pins no release. Point it at a release of
      <code>wildflowerhealthio/ohif-viewer-dist</code> to publish the viewer here.
    </p>
  </body>
</html>
`

const escapeHtml = (text: string): string =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')

export { matchesPin, parsePrebuiltConfig, renderStubPage, sha256Hex }
export type { PrebuiltConfig, PrebuiltPin }
