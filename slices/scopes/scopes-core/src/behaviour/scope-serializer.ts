/**
 * {@link ScopeSerializer} — the shared name for "render this scope value to its
 * canonical wire string". Each domain namespace with a wire form (the
 * {@link Scope} union, the {@link Fhir} / {@link Wildflower} resource grammars,
 * the {@link AccessRights} perms segment, the {@link UnknownScope} passthrough)
 * conforms by typing its `scopeSerialize` free function against this interface,
 * so the behaviour reads the same wherever it appears (mirrors Rust's `Display`).
 */
export interface ScopeSerializer<T> {
  /** Render `value` to its canonical scope (sub)string. */
  scopeSerialize(value: T): string
}
