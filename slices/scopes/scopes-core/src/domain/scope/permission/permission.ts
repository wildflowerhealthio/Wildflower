/**
 * The **base permission** — the editable *form* of a resource scope's permission.
 * It is generic over its interaction key `I` ({@link PermissionIdentity}), so the
 * picker, the grid cell builder, and the toggle op are written *once* on the base
 * {@link BasePermission} and read on the form's *own* `ReadonlySet<I>` (`'c'|…|'s'`
 * for cruds, `'read'|'write'` for the v1 words). Two instances:
 * {@link CrudsPermission} (the five SMART v2 `cruds` interactions, used by FHIR v2
 * *and* Wildflower) and {@link ReadWritePermission} (the two SMART v1 Read/Write
 * words, FHIR-only).
 *
 * **No cross-style conversion.** The styles are never collapsed into a single
 * currency — a permission is only ever compared, subtracted, or toggled against
 * *another value of its own style*. Every editing method takes and returns `This`,
 * so coverage/lock/dedupe stay same-style (the view-model relies on the invariant
 * that a scope context holds a single style, so the two sides of any comparison
 * always share `I`). A design that converts one style into the other is a bug.
 *
 * A pure leaf: it depends only on the permission algebra. It does NOT know about
 * wildcard resolution — that stays in the view-model {@link Resolve}, which asks a
 * same-style wildcard permission `has(interaction)` directly.
 */

/** One selectable control in a style (a grid cell, or a Read/Write checkbox). */
type Interaction<Id extends string = string> = {
  /** The control id (`c`/`r`/… for cruds, `read`/`write` for v1 words). */
  readonly id: Id
  /** The user-facing label, e.g. `Create` / `Read`. */
  readonly name: string
  /** The mono code shown beside the label. */
  readonly code: string
}

/** The result of subtracting a same-style permission's coverage from another (`spec.md §3`). */
type Subtraction<TPermission> =
  /** Fully covered — drop the scope. */
  | { readonly kind: 'covered' }
  /** Partially covered — emit a trimmed permission carrying only the remainder. */
  | { readonly kind: 'remainder'; readonly value: TPermission }
  /** Nothing covered — emit the permission whole. */
  | { readonly kind: 'whole' }

type InteractionId<T extends BasePermission<string>> = T extends BasePermission<infer I> ? I : never

/**
 * One editable permission style, generic over its interaction key `I`. Each method
 * reads on the style's *own* `ReadonlySet<I>` and returns a new instance of the
 * same style — there is no union narrowing and no conversion between styles.
 */
abstract class BasePermission<TInteractions extends string> {
  abstract kind: string
  abstract items: ReadonlyArray<Interaction<TInteractions>>
  /**
   * How a picker lays this style out — a cell matrix (`grid`, the cruds interactions) or a
   * single inline multiselect (`inline`, the v1 Read/Write words). The style owns its own
   * layout so the grid model reads it directly instead of string-matching on `kind`.
   */
  abstract layout: 'grid' | 'inline'

  readonly interactions: ReadonlySet<TInteractions>

  constructor(interactions: Iterable<TInteractions>) {
    this.interactions = new Set(interactions)
  }

  get allInteractions(): TInteractions[] {
    return this.items.map((i) => i.id)
  }

  abstract serialize(): string | null

  abstract label(): string

  abstract make(interactions: Iterable<TInteractions>): BasePermission<TInteractions>

  /**
   * Whether this permission includes the control `id`. Precise for a concrete style
   * (`'c'|…|'s'` for cruds); when the permission is erased to {@link BasePermission.Any}
   * the key degrades to `string`, which is what the view-model boundary needs.
   */
  has(id: string): boolean {
    return (this.interactions as ReadonlySet<string>).has(id)
  }

  /** Whether this permission grants nothing (an empty interaction set). */
  isEmpty(): boolean {
    return this.interactions.size === 0
  }

  /** Whether every interaction here is also in `other` (same style). */
  subsetOf(other: BasePermission<TInteractions>): boolean {
    for (const i of this.interactions) if (!other.has(i)) return false
    return true
  }

  /** This permission's interactions in canonical (items) order. */
  toArray(): readonly TInteractions[] {
    return this.allInteractions.filter((candidate) => this.has(candidate))
  }

  /** A new permission with `id` added. */
  withInteraction(id: TInteractions): BasePermission<TInteractions> {
    const next = new Set(this.interactions)
    next.add(id)
    return this.make(next)
  }

  /** A new permission with `id` removed. */
  withoutInteraction(id: TInteractions): BasePermission<TInteractions> {
    const next = new Set(this.interactions)
    next.delete(id)
    return this.make(next)
  }

  /** Flip `id`, returning a new permission of the same style. */
  toggle(id: TInteractions): BasePermission<TInteractions> {
    return this.has(id) ? this.withoutInteraction(id) : this.withInteraction(id)
  }

  /**
   * Subtract a same-style `covered` permission from this one (`spec.md §3` dedupe):
   * fully covered ⇒ `covered`; nothing covered ⇒ `whole`; partial ⇒ `remainder`
   * carrying only the uncovered interactions.
   */
  subtractCovered(covered: this): Subtraction<BasePermission<TInteractions>> {
    const remaining = [...this.interactions].filter((a) => !covered.has(a))
    if (remaining.length === 0) return { kind: 'covered' }
    if (remaining.length === this.interactions.size) return { kind: 'whole' }
    return { kind: 'remainder', value: this.make(remaining) }
  }
}

export { type Interaction, type Subtraction, BasePermission, type InteractionId }
