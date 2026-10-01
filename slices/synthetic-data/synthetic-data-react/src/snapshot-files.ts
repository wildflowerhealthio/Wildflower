import { Effect, Either } from 'effect'
import { unknownErrorToString } from 'kitchen-sink'
import { Snapshot } from 'synthetic-data-core'

/**
 * A published snapshot's files, fetched from the address it is served at.
 *
 * @remarks
 * A snapshot is static files on a web host (the data repo publishes to
 * GitHub Pages), so each file is one `GET` of its path resolved against the
 * snapshot's root. The request carries no credentials: a snapshot is public,
 * and a cookie for its host has no business on the request.
 *
 * @packageDocumentation
 */

/** The header file at the root of a snapshot, which a pasted address may end in. */
const HEADER_SUFFIX = `/${Snapshot.Header.PATH}`

/**
 * The root a snapshot's files are fetched from, from the address a reader
 * typed: an `http` or `https` URL naming the snapshot's directory or its
 * `index.json`, without a query or a fragment.
 *
 * @returns The root, ending in `/` so every path resolves beneath it; or why
 *   the address is not one
 */
const snapshotRootOf = (address: string): Either.Either<URL, string> => {
  const trimmed = address.trim()
  if (!URL.canParse(trimmed)) return Either.left('Enter the full address, starting https://.')
  const url = new URL(trimmed)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return Either.left('The address must start https:// or http://.')
  }
  const directory = url.pathname.endsWith(HEADER_SUFFIX)
    ? url.pathname.slice(0, -Snapshot.Header.PATH.length)
    : url.pathname
  const root = new URL(url.origin)
  root.pathname = directory.endsWith('/') ? directory : `${directory}/`
  return Either.right(root)
}

/** `404 Not Found`, or `404` when the response carries no status text. */
const statusLineOf = (response: Response): string =>
  response.statusText === '' ? String(response.status) : `${response.status} ${response.statusText}`

/** `GET` of `path` under `root`, failing as unreadable on a network error or a non-2xx. */
const fetchFile = (
  root: URL,
  path: string
): Effect.Effect<Response, Snapshot.Reader.UnreadableFile> =>
  Effect.tryPromise({
    try: (signal) => fetch(new URL(path, root), { credentials: 'omit', signal }),
    catch: (cause) =>
      new Snapshot.Reader.UnreadableFile({
        path,
        reason: `It could not be fetched: ${unknownErrorToString(cause)}`,
      }),
  }).pipe(
    Effect.filterOrFail(
      (response) => response.ok,
      (response) =>
        new Snapshot.Reader.UnreadableFile({
          path,
          reason: `The server answered ${statusLineOf(response)}.`,
        })
    )
  )

/** A fetched body, read as `read` does, failing as unreadable when the body does not arrive. */
const bodyOf = <TBody>(
  path: string,
  read: () => Promise<TBody>
): Effect.Effect<TBody, Snapshot.Reader.UnreadableFile> =>
  Effect.tryPromise({
    try: read,
    catch: (cause) =>
      new Snapshot.Reader.UnreadableFile({
        path,
        reason: `Its body could not be read: ${unknownErrorToString(cause)}`,
      }),
  })

/**
 * The `Snapshot.Reader.FileFetcher` of the snapshot served at `root`: each
 * file fetched without credentials.
 */
const fetcherAt = (root: URL): Snapshot.Reader.FileFetcher => ({
  text: (path) =>
    fetchFile(root, path).pipe(Effect.flatMap((response) => bodyOf(path, () => response.text()))),
  bytes: (path) =>
    fetchFile(root, path).pipe(
      Effect.flatMap((response) => bodyOf(path, () => response.arrayBuffer())),
      Effect.map((buffer) => new Uint8Array(buffer))
    ),
})

export { fetcherAt, snapshotRootOf }
