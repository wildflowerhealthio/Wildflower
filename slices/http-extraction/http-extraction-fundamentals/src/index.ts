/**
 * The vocabulary of extracting entities from HTTP traffic, exposed as one
 * namespace per module in the `effect` style: the file is the noun, the
 * principal type shares its name (`Source.Source`), and functions read in
 * the namespace's context (`Extraction.run`, `Recognizer.resolve`,
 * `HttpResponse.make`).
 *
 * @packageDocumentation
 */
export * as EntityDefinition from './entity-definition.ts'
export * as Extraction from './extraction.ts'
export * as HttpResponse from './http-response.ts'
export * as Recognizer from './recognizer.ts'
export * as Source from './source.ts'
export * as UrlMatch from './url-match.ts'
