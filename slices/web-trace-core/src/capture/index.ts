/**
 * The capture-side primitives a recording and a provenance capture share: what
 * a response's content type is, what its body hashes to, and how a body is
 * carried verbatim.
 *
 * @remarks
 * These live here, below both capture paths — the Recorder
 * (`apps/host/recorder`), which records a whole browsing session, omits
 * presentation assets by content type and caps body size, and a provenance
 * capture (`src/provenance/`), which stores verbatim but only for a response
 * that actually produced a resource. The **policy** differs; the primitives do
 * not, and a second copy of the hash or the content-type rule would drift from
 * what is already on disk.
 *
 * Nothing here decides *whether* a body is captured. That is the caller's
 * policy, and the two are deliberately different.
 *
 * @packageDocumentation
 */
export {
  BodyDigestUnavailable,
  contentTypeOf,
  sha256Base64,
  storeBodyVerbatim,
  UNKNOWN_CONTENT_TYPE,
} from './body.ts'
export type { CaptureHeaders } from './body.ts'
