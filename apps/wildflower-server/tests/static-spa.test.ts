import { Option } from 'effect'
import { expect, test } from 'vite-plus/test'
import { parsePathToAssetFile } from '../src/static-spa.ts'

test('the SPA root resolves to an empty relative path', () => {
  // The handler joins this with `webAssetsDir`, the stat-check misses
  // (a directory, not a file), and the response falls through to
  // index.html — same outcome as a deep-link route.
  expect(parsePathToAssetFile('')).toEqual(Option.some(''))
  expect(parsePathToAssetFile('/')).toEqual(Option.some(''))
})

test('returns the cleaned relative path for a normal asset', () => {
  expect(parsePathToAssetFile('/assets/app.js')).toEqual(Option.some('assets/app.js'))
  expect(parsePathToAssetFile('/favicon.ico')).toEqual(Option.some('favicon.ico'))
})

test('rejects literal parent-directory traversal', () => {
  // The handler bounces `none()` to `/` rather than serving the SPA
  // shell — confused users land somewhere working, probes don't get a
  // 200 OK at the URL they picked.
  expect(parsePathToAssetFile('/../etc/passwd')).toEqual(Option.none())
  expect(parsePathToAssetFile('../etc/passwd')).toEqual(Option.none())
  expect(parsePathToAssetFile('/foo/../../etc/passwd')).toEqual(Option.none())
})

test('rejects percent-encoded parent-directory traversal', () => {
  // `URL` parsing only collapses literal `..` segments — `%2E%2E` stays
  // encoded in the pathname. We decode each segment ourselves so probes
  // can't sneak past via encoding.
  expect(parsePathToAssetFile('/%2E%2E/etc/passwd')).toEqual(Option.none())
  expect(parsePathToAssetFile('/%2e%2e/etc/passwd')).toEqual(Option.none())
  expect(parsePathToAssetFile('/foo/%2e./etc')).toEqual(Option.none())
})

test('rejects malformed percent-encoding', () => {
  // A lone `%` (no two hex digits) throws inside `decodeURIComponent`.
  // Treat that as suspicious rather than try to interpret it.
  expect(parsePathToAssetFile('/foo%')).toEqual(Option.none())
})

test('rejects null-byte injection', () => {
  expect(parsePathToAssetFile('/assets/app\0.js')).toEqual(Option.none())
})

test('strips multiple leading slashes', () => {
  expect(parsePathToAssetFile('//assets//app.js')).toEqual(Option.some('assets/app.js'))
})

test('passes deep-link routes through — caller distinguishes via FS stat', () => {
  // `parsePathToAssetFile` only filters traversal/null/malformed. Deep-link
  // routes like `/gatekeeper/requests` look like real paths from this
  // function's perspective; the static-spa handler distinguishes "real
  // file on disk" from "SPA route" by stat-ing the candidate and falling
  // back to index.html when the stat misses.
  expect(parsePathToAssetFile('/gatekeeper/requests')).toEqual(Option.some('gatekeeper/requests'))
})
