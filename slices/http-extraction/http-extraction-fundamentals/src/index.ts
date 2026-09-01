/**
 * The vocabulary of extracting entities from HTTP traffic, exposed as one
 * namespace per module in the `effect` style: the file is the noun, the
 * principal type shares its name (`HttpResponseKind.HttpResponseKind`), and
 * functions read in the namespace's context (`Extraction.routeTo`,
 * `Extraction.parseWith`, `HttpResponse.make`).
 *
 * @packageDocumentation
 */
export * as HttpResponseKind from './http-response-kind.ts'
export type { RecognizedUrlData } from './http-response-kind.ts'
export * as Extraction from './extraction.ts'
export * as HttpResponse from './http-response.ts'
export * as SourceDescriptor from './source-descriptor.ts'
export { Specificity } from './specificity.ts'
export * as UrlMatch from './url-match.ts'
export type { UrlMatcher } from './url-match.ts'
