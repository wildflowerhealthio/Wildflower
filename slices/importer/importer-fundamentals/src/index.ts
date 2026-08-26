/**
 * The vocabulary of importing, exposed as one namespace per module in the
 * `effect` style: the file is the noun, the principal type shares its name
 * (`Importer.Importer`), and functions read in the namespace's context
 * (`Extraction.run`, `Recognizer.resolve`, `ImportableResponse.make`).
 *
 * @packageDocumentation
 */
export * as EntityDefinition from './entity-definition.ts'
export * as Extraction from './extraction.ts'
export * as ImportableResponse from './importable-response.ts'
export * as Importer from './importer.ts'
export * as Recognizer from './recognizer.ts'
export * as UrlMatch from './url-match.ts'
