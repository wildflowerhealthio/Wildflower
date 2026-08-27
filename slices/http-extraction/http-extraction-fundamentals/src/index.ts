/**
 * The vocabulary of extracting entities from HTTP traffic, exposed as one
 * namespace per module in the `effect` style: the file is the noun, the
 * principal type shares its name (`Source.Source`), and functions read in
 * the namespace's context (`Extraction.run`, `Source.resolve`,
 * `HttpResponse.make`).
 *
 * @packageDocumentation
 */
export * as HttpResponseKind from './http-response-kind.ts'
export * as Extraction from './extraction.ts'
export * as HttpResponse from './http-response.ts'
export * as Source from './source.ts'
export * as UrlMatch from './url-match.ts'
