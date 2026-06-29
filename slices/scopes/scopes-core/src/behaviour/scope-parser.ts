/**
 * {@link ScopeParser} — the shared name for "parse a scope (sub)string into this
 * domain value, or `null` when the string isn't one". Each domain namespace with
 * a *partial* parse (the {@link Fhir} / {@link Wildflower} grammars, a
 * {@link KnownScope} flag, an {@link AccessRights} perms segment) conforms by
 * typing its `scopeParse` free function against this interface.
 *
 * The {@link Scope} union's own parse is the *total* orchestrator over these — it
 * tries each in turn and falls back to `unknown`, so it never returns `null` and
 * keeps its own narrower signature rather than implementing this interface.
 */
export interface ScopeParser<T> {
  /** Parse `input` into a `T`, or `null` when it isn't one of these. */
  scopeParse(input: string): T | null
}
