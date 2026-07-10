import { Schema } from 'effect'

/**
 * Like {@link Schema.suspend}, but attaches an opaque `toJSON` to the resulting
 * Suspend AST so `JSON.stringify(schema.ast)` will not expand the suspended
 * subtree. The call site supplies a stable structural fingerprint via `name`;
 * the helper renders it as `{ _tag: 'Suspend', ref: name }` whenever the AST
 * is JSON-stringified.
 *
 * @remarks
 * Effect's default `Suspend.toJSON` caches the fully-expanded subtree on
 * first resolution and returns that cache on every subsequent visit. Since
 * `JSON.stringify` walks shared subtrees inline at every reference site,
 * highly-shared graphs (FHIR's mutually-recursive Reference⇄Identifier⇄
 * Extension) blow the output up exponentially. Anything that hashes a schema
 * by stringifying its AST (historically livestore's per-event migration
 * check via `validateEventDef`) OOMs at boot. A stable opaque fingerprint sidesteps
 * the expansion while keeping schema hashes meaningful: distinct names hash
 * to distinct values, identical names collapse.
 *
 * Use this in place of `Schema.suspend` at every site that participates in a
 * cycle or in a shared DAG. Pick a `name` that uniquely identifies the
 * resolved schema (typically its data type name, e.g. `'Reference'`,
 * `'Identifier'`, `'Extension'`).
 *
 * @param thunk - Resolves the suspended schema lazily. Same semantics as
 *   `Schema.suspend`'s thunk argument.
 * @param name - Stable fingerprint identifying the resolved schema. Two
 *   `Schema.suspend` sites that resolve to schemas which should compare
 *   unequal must use different names.
 */
export const suspendWithShallowJson = <A, I, R>(
  thunk: () => Schema.Schema<A, I, R>,
  name: string
): Schema.Schema<A, I, R> => {
  const suspended = Schema.suspend(thunk)
  Object.defineProperty(suspended.ast, 'toJSON', {
    value: (): { readonly _tag: 'Suspend'; readonly ref: string } => ({
      _tag: 'Suspend',
      ref: name,
    }),
    enumerable: false,
    configurable: true,
    writable: true,
  })
  return suspended
}
