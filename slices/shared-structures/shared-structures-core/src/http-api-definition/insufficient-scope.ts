import { Schema } from 'effect'

/**
 * The shared `403` authorization-failure body: the caller **authenticated**,
 * but their token doesn't cover the scope(s) the operation requires. Emitted
 * identically by every scope-gated slice via the Rust
 * `scope_capabilities_rust::insufficient_scope` / `InsufficientScopeBody`
 * (`#[serde(rename_all = "camelCase")]`), so a single TS definition mirrors it
 * everywhere:
 *
 * ```json
 * { "error": "InsufficientScope", "missingScopes": ["wildflower/Grant.d", "system/*.rs"] }
 * ```
 *
 * `error` is the constant discriminant a client switches on (note it is the
 * field `error`, **not** an Effect `_tag`). `missingScopes` names the scopes
 * the caller must additionally hold, as canonical scope strings that
 * `scopes-core` can parse back into a structured `Scope` for display.
 *
 * Attach it to a scope-gated endpoint (or group) with
 * `.addError(InsufficientScopeSchema, { status: 403 })` so the generated
 * client decodes the body onto its failure channel instead of surfacing an
 * opaque `ResponseError`.
 */
const InsufficientScopeSchema = Schema.Struct({
  /** Always the literal `"InsufficientScope"` — the discriminant. */
  error: Schema.Literal('InsufficientScope'),
  /** The rendered scopes the caller lacks (e.g. `wildflower/Grant.d`). */
  missingScopes: Schema.Array(Schema.String),
})

/** The decoded shape of an {@link InsufficientScopeSchema} 403 body. */
type InsufficientScope = Schema.Schema.Type<typeof InsufficientScopeSchema>

/**
 * Structural type guard for a decoded {@link InsufficientScope} body. Pure —
 * no Effect runtime required — so both the web query runtime (matching a
 * failed request) and the read-only scope surface can import it. It does not
 * unwrap `FiberFailure`/`ResponseError`; callers that hold a rejected-request
 * error should unwrap first (see `router-context.ts`).
 */
const isInsufficientScopeBody: (value: unknown) => value is InsufficientScope =
  Schema.is(InsufficientScopeSchema)

export { InsufficientScopeSchema, isInsufficientScopeBody }
export type { InsufficientScope }
