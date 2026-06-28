/**
 * Resource scopes — the `context/Type.perms` shapes — and the CRUDS access
 * rights they share, mirroring `scopes-rust`'s `scope/resource/mod.rs`. The FHIR
 * ({@link Fhir}) and Wildflower ({@link Wildflower}) grammars and their shared
 * permission machinery ({@link AccessRights}) are each their own namespace.
 */

export * as AccessRights from './access-rights.ts'
export * as Fhir from './fhir.ts'
export * as Wildflower from './wildflower.ts'
