# fhir-r4 Consumer Gotchas Reference

Gotchas that bite **other packages** consuming `fhir-r4` — either building new schemas from its datatype schemas, or reading resources it has already decoded. For where the client itself deviates from the FHIR R4 spec, see the [Client Capabilities Reference](./Client%20Capabilities%20Reference.md).

## Building schemas from fhir-r4 datatypes: keep the top-level interface re-exports (TS2883)

When a package builds `Schema.Struct`s that spread or reference `fhir-r4`'s datatype schemas (`...DomainResource.fields`, `Extension.Schema`, `Bundle.searchsetBundle(...)`), the struct's inferred decoded type embeds `fhir-r4`'s named interfaces — `ExtensionType`, `ReferenceType`, `IdentifierType`, and `BundleValue` for the bundle factory. `tsgo`'s declaration emit can name those only if `fhir-r4` re-exports them **at the top level**. A namespace-only re-export (`export * as Extension` → `Extension.Type`) is not nameable from the consumer's `.d.ts`, so `vp pack` fails with **TS2883** ("cannot be named without a reference to 'ExtensionType'").

`vp check` (typecheck only) stays green — the leak bites only at `.d.ts` generation. Run `vp pack` on the **consuming** package to catch it.

The fix lives on the producer. `data-types/index.ts` carries a direct top-level re-export of each leaked interface:

```typescript
export type { Type as ExtensionType } from './special-purpose/extension.ts'
export type { ReferenceType, IdentifierType } from './complex/identifier-and-reference.ts'
export type { BundleValue } from './resources/bundle.ts'
```

Keep these if you touch `fhir-r4` — removing one breaks every consumer's `vp pack`. When a consumer's inferred type names a new internal interface, re-export it flat from the producer rather than hand-rolling wire interfaces in the consumer (which is far more code, and forces exporting every `Encoded` interface too, or a wrapper referencing them fails with TS4023). Known consumers: `fhir-stu3-as-r4`, `rexall-be-well-collector` and `medication-core` (whose `medication-core/fhir` subpath is a separate `vp pack` entry, so pack that package, not just the root); the consumer-side view of this trap is pinned in [fhir-stu3-as-r4's AGENTS.md](../../fhir-stu3-as-r4/AGENTS.md).

## Re-decoding an already-decoded resource: `uri`/`url` fields are `URL`, not `string`

A FHIR `uri` primitive stays a plain string on the wire and on loosely-typed `contained` resources, but on a **fully-typed, already-decoded** `fhir-r4` resource it is a `URL` instance. `Coding.system`, `Identifier.system`, and `Attachment.url` are tightened to `Schema.URL`, so `sys instanceof URL === true` and `JSON.stringify` renders it unquoted. Re-decoding such a resource through a permissive local `Schema.Struct` with `system: Schema.String` then returns `Option.none()` for the whole concept whenever a top-level coding carries a system — silently disabling any `=== <system-uri>` comparison downstream.

The asymmetry is the tell: the same field reads as a `string` on a `contained` resource and as a `URL` on the top-level concept. `vp check` won't catch it; only a runtime decode of a resource carrying the field does.

When re-decoding an already-decoded resource (not raw wire) through a permissive local schema, either read `uri`/`url` fields as `Schema.Unknown`, or coerce both shapes to the string form:

```typescript
const nullableUri = Schema.transform(
  Schema.Union(Schema.String, Schema.instanceOf(URL)),
  Schema.String,
  {
    decode: (v) => (typeof v === 'string' ? v : v.href),
    encode: (v) => v,
  }
)
```

Better still, skip the local schema: when the slot is merely typed `any` on an already-decoded resource (a `medication[x]` choice slot), decode it with `Schema.typeSchema(<fhir-r4 schema>)`, which expects exactly the decoded shape (`URL`, `DateTime.Utc`); and decode a raw-wire `contained` entry with the full fhir-r4 resource schema. `medication-core`'s `src/fhir/medication-request.ts` accessors do this — an earlier version hand-coerced `Coding.system` after a string-typed local `system` silently disabled its DIN and display-name fallbacks. The same asymmetry hits `dateTime` fields, which decode to an Effect `DateTime.Utc` on the typed top level.

## See Also

- [Client Capabilities Reference](./Client%20Capabilities%20Reference.md) — where the client narrows or postpones the FHIR R4 spec
- [slices/emr/AGENTS.md](../../AGENTS.md) — the emr slice overview and guardrails
