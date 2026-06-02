import { Data } from 'effect'

type DuplicateTagKind = 'inbound' | 'outbound' | 'urlParams' | 'wire'

/**
 * Tagged error raised when a tag is registered for more than one bridge
 * (per direction). The handler-registry's `register` surfaces this on
 * the typed failure channel so a runtime wiring collision can be caught
 * by callers rather than falling through to a defect-logger.
 */
class DuplicateTagError extends Data.TaggedError('DuplicateTagError')<{
  readonly kind: DuplicateTagKind
  readonly tags: ReadonlyArray<string>
}> {
  override get message(): string {
    return `[effect-messaging] duplicate ${this.kind} tag(s) "${this.tags.join('", "')}"`
  }
}

/**
 * The single "a tag is owned by exactly one bridge (per direction)" guard.
 *
 * @remarks
 * Folds an iterable of tag names, collecting every tag seen more than once,
 * and throws synchronously listing all repeats — a wiring error that should
 * fail loudly at construction (or at a per-tag lookup). `kind` names the
 * direction/channel being validated so the one message format stays
 * informative across the four call sites it replaced (inbound + outbound
 * dispatch maps, URL-param lookup, wire-schema lookup).
 *
 * For the per-tag lookups, callers pass the requested tag once per bridge
 * that owns it, so a tag owned by two bridges arrives as a repeat here.
 *
 * Callers that need a typed failure (rather than a synchronous throw)
 * should catch the {@link DuplicateTagError} thrown here and re-raise on
 * an Effect's failure channel.
 */
const assertNoDuplicateTags = (tags: Iterable<string>, kind: DuplicateTagKind): void => {
  const seen = new Set<string>()
  const repeats = new Set<string>()
  for (const tag of tags) {
    if (seen.has(tag)) {
      repeats.add(tag)
    } else {
      seen.add(tag)
    }
  }
  if (repeats.size > 0) {
    throw new DuplicateTagError({ kind, tags: [...repeats] })
  }
}

export { assertNoDuplicateTags, DuplicateTagError }
export type { DuplicateTagKind }
