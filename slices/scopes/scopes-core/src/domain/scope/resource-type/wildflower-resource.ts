import { Hash, Equal } from 'effect'
import BaseResourceType from './resource-type'

abstract class WildflowerResourceType extends BaseResourceType {
  supersetOf(other: BaseResourceType): boolean {
    if (!(other instanceof WildflowerResourceType)) return false
    if (this instanceof WildflowerResourceType.Wildcard) return true
    if (other instanceof WildflowerResourceType.Wildcard) return false
    if (
      this instanceof WildflowerResourceType.Known &&
      other instanceof WildflowerResourceType.Known
    ) {
      return this.resource === other.resource
    }

    return false
  }
}

/** Strict 1:1 Wildflower admin `Resource` → display name. */
const RESOURCE_LABELS: Readonly<Record<string, { label: string; plural: string }>> = {
  AuthorizationRequest: { label: 'Authorization request', plural: 'Authorization requests' },
  Grant: { label: 'Grant', plural: 'Grants' },
  Client: { label: 'Connected app', plural: 'Connected apps' },
  RefreshToken: { label: 'Refresh token', plural: 'Refresh tokens' },
}

// oxlint-disable import/group-exports
namespace WildflowerResourceType {
  export class Known extends WildflowerResourceType {
    kind = 'wildflowerKnown' as const
    resource: Resource

    constructor(resource: Resource) {
      super()
      this.resource = resource
    }

    serialize(): string {
      return this.resource
    }

    singularLabel(): string {
      return Resource.singularLabel(this.resource)
    }

    pluralLabel(): string {
      return Resource.pluralLabel(this.resource)
    }

    [Hash.symbol](): number {
      return Hash.combine(Hash.string(this.kind))(Hash.string(this.resource))
    }

    [Equal.symbol](that: Equal.Equal): boolean {
      return that instanceof Known && this.kind === that.kind && this.resource === that.resource
    }

    static parse(s: string): Known | null {
      return Resource.is(s) ? new Known(s) : null
    }
  }

  export class Wildcard extends WildflowerResourceType {
    kind = 'wildflowerWildcard' as const

    /** The required "current and future" note shown wherever a wildcard is selectable (`spec.md §4`). */
    static readonly NOTE = 'Covers all current and future record types.'

    serialize(): string {
      return '*'
    }

    singularLabel(): string {
      return '✶ Any record type'
    }

    pluralLabel(): string {
      return '✶ All record types'
    }

    [Hash.symbol](): number {
      return Hash.string(this.kind)
    }

    [Equal.symbol](that: Equal.Equal): boolean {
      return that instanceof Wildcard && this.kind === that.kind
    }

    static parse(s: string): Wildcard | null {
      return s === '*' ? new Wildcard() : null
    }
  }

  /** A Wildflower-specific resource the gatekeeper governs (Rust's `WildflowerResource`). */
  export type Resource = 'AuthorizationRequest' | 'Grant' | 'Client' | 'RefreshToken'

  namespace Resource {
    export const all: readonly Resource[] = [
      'AuthorizationRequest',
      'Grant',
      'Client',
      'RefreshToken',
    ]

    /** Whether a string is one of the closed set of Wildflower admin resources. */
    export const is = (s: string): s is Resource => (all as readonly string[]).includes(s)

    export const singularLabel = (r: Resource): string => {
      if (r in RESOURCE_LABELS) return RESOURCE_LABELS[r].label
      // oxlint-disable-next-line no-console
      console.warn(`WildflowerResourceType.Resource.singularLabel: unknown resource ${r as string}`)
      return r
    }

    export const pluralLabel = (r: Resource): string => {
      if (r in RESOURCE_LABELS) return RESOURCE_LABELS[r].plural
      // oxlint-disable-next-line no-console
      console.warn(`WildflowerResourceType.Resource.pluralLabel: unknown resource ${r as string}`)
      return `${r}s`
    }
  }

  export const parse = (s: string): WildflowerResourceType | null => {
    const wildcard = Wildcard.parse(s)
    if (wildcard !== null) return wildcard

    const known = Known.parse(s)
    if (known !== null) return known

    return null
  }
}

export default WildflowerResourceType
