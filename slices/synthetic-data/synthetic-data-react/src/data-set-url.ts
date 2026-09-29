import { Data, Either } from 'effect'

/**
 * Where a data set is read from: the root of its static host, which every
 * path the manifest lists (`index.json`, `fhir/…`, `har/…`, `dicom/…`) is
 * relative to.
 */

/** The published data set: `wildflowerhealthio/synthetic-data`, served by GitHub Pages. */
const DEFAULT_DATA_SET_URL = 'https://wildflowerhealthio.github.io/synthetic-data/'

/** A URL that cannot be read as a data set's root, and why. */
class InvalidDataSetUrl extends Data.TaggedError('InvalidDataSetUrl')<{
  readonly url: string
  readonly reason: string
}> {}

/**
 * `url` as the root a data set's paths resolve against: an `http:` or
 * `https:` URL with no query or fragment, its path ending in `/` so that
 * `new URL('index.json', root)` stays inside it.
 *
 * @remarks
 * `http:` is allowed so a data set served from this computer
 * (`http://localhost:8000/`) can be loaded while it is developed; the browser
 * decides whether an `https:` page may read it.
 *
 * @param url - What the reader typed or passed as `?dataSet=`
 * @returns The root, or an {@link InvalidDataSetUrl} saying what is wrong
 */
const dataSetRootOf = (url: string): Either.Either<URL, InvalidDataSetUrl> => {
  const trimmed = url.trim()
  const invalid = (reason: string): Either.Either<never, InvalidDataSetUrl> =>
    Either.left(new InvalidDataSetUrl({ url: trimmed, reason }))
  if (!URL.canParse(trimmed))
    return invalid('It is not a full URL, such as https://example.com/data/.')
  const root = new URL(trimmed)
  if (root.protocol !== 'https:' && root.protocol !== 'http:') {
    return invalid('A data set is read over https: or http:.')
  }
  if (root.search !== '' || root.hash !== '') {
    return invalid('A data set URL is the folder that holds index.json, with no ? or # part.')
  }
  if (!root.pathname.endsWith('/')) root.pathname = `${root.pathname}/`
  return Either.right(root)
}

export { DEFAULT_DATA_SET_URL, dataSetRootOf, InvalidDataSetUrl }
