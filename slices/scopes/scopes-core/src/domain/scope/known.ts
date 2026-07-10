/**
 * Broadly-known non-resource (flag) scopes — `openid`, `offline_access`, the
 * launch-context scopes — mirroring `scopes-rust`'s `KnownScope`
 * (`scope/known.rs`). These match exactly; they are never resource scopes.
 *
 * Namespace module (`import { KnownScope } from 'scopes-core'`): the enum is
 * {@link KnownScope}, with `KnownScope.scopeParse`, `KnownScope.is`, `KnownScope.ALL`.
 */
import { Equal, Hash } from 'effect'
import { BaseScope } from './scope.ts'

/** Plain-language consent copy for each known scope (`spec.md §7`). */
const SCOPE_EXPLANATIONS: Readonly<Record<KnownScope.Name, string>> = {
  openid: 'Confirm who you are',
  profile: 'Your basic profile details',
  fhirUser: 'Link to your patient record',
  // States the gatekeeper's 15-minute `ACCESS_TOKEN_TTL`: without
  // offline_access there is no refresh token, so access ends when the
  // short-lived token expires. Keep in step with that constant.
  offline_access: 'Access your data after 15 minutes',
  launch: 'Know how the app was launched',
  'launch/patient': 'Open a specific patient',
}

/**
 * The known-scope (flag) variant of the union (`Scope::Known` in Rust). Structurally
 * comparable by its `scope` (like the {@link Contexts.Context} / {@link ResourceType}
 * siblings) so two `KnownScope`s of the same flag are {@link Equal.equals} — flag
 * membership ({@link Grant.hasKnown}) and dedupe compare by value, not identity.
 */
class KnownScope extends BaseScope implements Equal.Equal {
  readonly kind = 'known' as const
  readonly name: KnownScope.Name

  constructor(name: KnownScope.Name) {
    super()
    this.name = name
  }

  [Hash.symbol](): number {
    return Hash.combine(Hash.string(this.kind))(Hash.string(this.name))
  }

  [Equal.symbol](that: Equal.Equal): boolean {
    return that instanceof KnownScope && this.kind === that.kind && this.name === that.name
  }

  serialize(): string {
    return this.name
  }

  plainExplanation(): string {
    return SCOPE_EXPLANATIONS[this.name]
  }

  /**
   * Add or remove `flag` in a flag list, returning the NEW list — idempotent set
   * membership (no duplicate on re-add). The flag-scope counterpart of the resource
   * editing algebra ({@link ScopeConfiguration.toggleItem}).
   */
  static setFlag(
    flags: readonly KnownScope[],
    flag: KnownScope.Name,
    on: boolean
  ): readonly KnownScope[] {
    const without = flags.filter((known) => known.name !== flag)
    return on ? [...without, new KnownScope(flag)] : without
  }

  /** Flip `flag` in a flag list, returning the NEW list. */
  static toggleFlag(flags: readonly KnownScope[], flag: KnownScope.Name): readonly KnownScope[] {
    return KnownScope.setFlag(flags, flag, !flags.some((known) => known.name === flag))
  }

  /**
   * `flags` reordered into the canonical {@link KnownScope.Name.all} order (`spec.md §7`)
   * — the display order every flag list renders in. De-duplicates by name.
   */
  static inCanonicalOrder(flags: readonly KnownScope[]): readonly KnownScope[] {
    const byName = new Map(flags.map((known) => [known.name, known]))
    return KnownScope.Name.all.flatMap((name) => byName.get(name) ?? [])
  }
}

// oxlint-disable import/group-exports
namespace KnownScope {
  /** A broadly-known non-resource scope that matches exactly (Rust's `KnownScope`). */
  export type Name =
    | 'openid'
    | 'profile'
    | 'fhirUser'
    | 'offline_access'
    | 'launch'
    | 'launch/patient'

  export namespace Name {
    export const all = [
      'openid',
      'profile',
      'fhirUser',
      'offline_access',
      'launch',
      'launch/patient',
    ] as const satisfies readonly Name[]
    /** Whether a string is a known flag scope. */
    export const is = (s: string): s is Name => (all as readonly string[]).includes(s)
  }

  export const parse = (s: string): KnownScope | null => (Name.is(s) ? new KnownScope(s) : null)
  export const openid = new KnownScope('openid')
  export const profile = new KnownScope('profile')
  export const fhirUser = new KnownScope('fhirUser')
  export const offlineAccess = new KnownScope('offline_access')
  export const launch = new KnownScope('launch')
  export const launchPatient = new KnownScope('launch/patient')
}

export default KnownScope
