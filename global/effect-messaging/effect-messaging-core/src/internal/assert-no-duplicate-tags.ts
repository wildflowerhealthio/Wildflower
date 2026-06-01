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
 */
const assertNoDuplicateTags = (
  tags: Iterable<string>,
  kind: 'inbound' | 'outbound' | 'urlParams' | 'wire'
): void => {
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
    throw new Error(`[effect-messaging] duplicate ${kind} tag(s) "${[...repeats].join('", "')}"`)
  }
}

export { assertNoDuplicateTags }
