import { Schema } from 'effect'
import { Har } from 'http-archive'

/**
 * Handing a finished archive to the reader — as a blob from the app's own
 * origin, and nothing else.
 *
 * @remarks
 * **No network egress at any point** — the premise of the app, not a
 * preference. The download is an object URL over bytes already in the page:
 * there is no upload step, no share endpoint, and no place to add one.
 *
 * @packageDocumentation
 */

/** What a HAR is served as. HAR 1.2 is JSON; the extension is what names it. */
const HAR_MEDIA_TYPE = 'application/json'

/** Characters a file name keeps; everything else becomes a hyphen. */
const UNSAFE_FILE_NAME_CHARACTERS = /[^a-zA-Z0-9._-]+/g

/**
 * The output name for the anonymized archive.
 *
 * @param sourceFileName - The name of the `.har` file the user picked
 * @returns `<original-stem>.anonymized.har`, safe for any host filesystem
 *
 * @remarks
 * The stem is the source name with a trailing `.har`/`.HAR` extension stripped
 * (only the last one — a name like `example.har.har` becomes `example.har`)
 * before sanitisation. A stem that sanitises to nothing falls back to
 * `archive`, so the output is never a hidden `.anonymized.har` on Unix (which
 * would look like the download silently failed).
 *
 * A source name comes from the file picker, not from this package, so a `/` or
 * `\` in it would otherwise read as a directory separator to the browser's
 * download handler.
 */
const anonymizedFileName = (sourceFileName: string): string => {
  const withoutExtension = sourceFileName.replace(/\.har$/iu, '')
  const safe = withoutExtension.replace(UNSAFE_FILE_NAME_CHARACTERS, '-').replace(/^-+|-+$/g, '')
  return `${safe === '' ? 'archive' : safe}.anonymized.har`
}

/** The archive as the JSON the HAR spec describes. */
const encodeHar = Schema.encodeSync(Har)

/**
 * The archive as a blob.
 *
 * @param har - The emitted archive
 * @returns A JSON blob of the archive, indented
 *
 * @remarks
 * The archive is *encoded* before it is stringified: `emitHarFromLog` builds
 * the decoded form, whose instants are `DateTime`s and whose bodies are a
 * tagged union, and stringifying that directly would write a file no HAR reader
 * accepts.
 *
 * Indented because a HAR is read by a person as often as by a tool.
 */
const harBlob = (har: Har): Blob =>
  new Blob([JSON.stringify(encodeHar(har), null, 2)], { type: HAR_MEDIA_TYPE })

/**
 * Saves a blob under a file name, through the browser's own download path.
 *
 * @param blob - The bytes to save
 * @param fileName - The name to suggest
 *
 * @remarks
 * An object URL over an in-memory blob: same origin, no request. The URL is
 * revoked immediately after the click — it holds the blob alive in the
 * document, and the download has already taken its own reference by then.
 */
const downloadBlob = (blob: Blob, fileName: string): void => {
  const objectUrl = URL.createObjectURL(blob)
  try {
    const anchor = document.createElement('a')
    anchor.href = objectUrl
    anchor.download = fileName
    anchor.rel = 'noopener'
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

export { anonymizedFileName, downloadBlob, HAR_MEDIA_TYPE, harBlob }
