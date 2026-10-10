/**
 * The capture-side primitives every recorder and every provenance collector
 * shares: what a response's content type is, what its body hashes to, and how a
 * body is carried verbatim.
 *
 * @remarks
 * These live here rather than in a collector because there are two consumers
 * that cannot import each other — `web-trace-collector`, which records a whole
 * browsing session under an allowlist and a size cap, and the production
 * collectors, which capture verbatim but only for a response that actually
 * produced a resource. The **policy** differs; the primitives do not, and a
 * second copy of the hash or the content-type rule would drift from what is
 * already on disk.
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
