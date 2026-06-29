/**
 * `behaviour/` — interfaces that name the behaviours recurring across the domain
 * namespaces, so "serialize a scope" and "parse a scope" read the same wherever
 * they appear. Pure type contracts with no runtime: each domain module conforms
 * by typing its free functions against them ({@link ScopeSerializer.scopeSerialize},
 * {@link ScopeParser.scopeParse}).
 */

export * from './scope-serializer.ts'
export * from './scope-parser.ts'
