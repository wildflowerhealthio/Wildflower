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

/**
 * Strict 1:1 Wildflower admin `Resource` → display name. Keyed by the closed
 * {@link WildflowerResourceType.Resource} set, so the map is exhaustive and every
 * lookup is total — adding a resource is a compile error until it's labelled.
 */
const RESOURCE_LABELS: Readonly<
  Record<WildflowerResourceType.Resource, { label: string; plural: string }>
> = {
  AuthorizationRequest: { label: 'Authorization request', plural: 'Authorization requests' },
  Grant: { label: 'Grant', plural: 'Grants' },
  Client: { label: 'Connected app', plural: 'Connected apps' },
  RefreshToken: { label: 'Refresh token', plural: 'Refresh tokens' },
  Token: { label: 'Token', plural: 'Tokens' },
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

    protected equalityKey(): string {
      return this.resource
    }

    static parse(s: string): Known | null {
      return Resource.is(s) ? new Known(s) : null
    }
  }

  export class Wildcard extends WildflowerResourceType {
    kind = 'wildflowerWildcard' as const

    serialize(): string {
      return '*'
    }

    singularLabel(): string {
      return 'Any Record'
    }

    pluralLabel(): string {
      // Mid-sentence in the running statements ("Read all admin record
      // types") — the Wildflower counterpart of the FHIR wildcard label.
      return 'all admin record types'
    }

    protected equalityKey(): string {
      return '*'
    }

    static parse(s: string): Wildcard | null {
      return s === '*' ? new Wildcard() : null
    }
  }

  /** A Wildflower-specific resource the gatekeeper governs (Rust's `WildflowerResource`). */
  export type Resource = 'AuthorizationRequest' | 'Grant' | 'Client' | 'RefreshToken' | 'Token'

  namespace Resource {
    export const all: readonly Resource[] = [
      'AuthorizationRequest',
      'Grant',
      'Client',
      'RefreshToken',
      'Token',
    ]

    /** Whether a string is one of the closed set of Wildflower admin resources. */
    export const is = (s: string): s is Resource => (all as readonly string[]).includes(s)

    export const singularLabel = (r: Resource): string => RESOURCE_LABELS[r].label

    export const pluralLabel = (r: Resource): string => RESOURCE_LABELS[r].plural
  }

  export const parse = (s: string): WildflowerResourceType | null => {
    const wildcard = Wildcard.parse(s)
    if (wildcard !== null) return wildcard

    const known = Known.parse(s)
    if (known !== null) return known

    return null
  }

  /** The `*` wildcard resource as a shared singleton — prefer this to `parse('*')`. */
  export const wildcardResourceType: WildflowerResourceType = new Wildcard()

  /**
   * The labelled Wildflower admin resource types the picker lists as rows, in canonical
   * order — the {@link Resource.all} set surfaced as scope-name strings. The Wildflower
   * counterpart to {@link FhirResourceType.catalog}; the `*` wildcard row is injected by the
   * grid, so it is deliberately not in the catalog.
   */
  export const catalog: readonly string[] = Resource.all
}

export default WildflowerResourceType
