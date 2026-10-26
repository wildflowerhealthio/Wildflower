/**
 * The link plan: everything placing a decoded file on the identity map needs,
 * worked out once from the file and the reviewer's choices.
 *
 * @remarks
 * A referent's mentions are redirected to its destination. The plan says what
 * each referent's destination is, what each destination resource becomes once
 * it has assumed the identifiers of the referents linked to it, and which
 * literals move. Built by {@link make}, read by the redirect and the
 * placement, and what the batch lift hands across files.
 *
 * @packageDocumentation
 */

import type { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import { Option, pipe } from 'effect'

import * as DecodedFile from '../decoded-file.ts'
import * as Destination from './destination.ts'
import * as Identity from './identity.ts'
import type * as LinkChoice from './link-choice.ts'
import * as LinkableResource from './linkable-resource.ts'
import * as Referent from './referent.ts'
import * as Resolution from './resolution.ts'

type Identifier = IdentifierAndReference.IdentifierType

/** A stored or provisional resource referents link to, as it will be written. */
interface LinkedResource {
  /** The resource, having assumed every identifier the referents linked to it bring. */
  readonly resource: LinkableResource.WithId
  /** What it assumed: the identifiers a decoded copy of it in the file assumes too. */
  readonly assumed: readonly Identifier[]
  /**
   * Whether the file holds no resource for it, only mentions: linked to by
   * referents without a resource alone, and under a literal no decoded
   * resource carries. Such a resource is appended to the file, so the review
   * and the diff show what it gained.
   */
  readonly existsOnlyAsMentionInFile: boolean
}

interface Type {
  /** Each referent's destination, by `Referent.key`. */
  readonly destinations: ReadonlyMap<string, Destination.Type>
  /** Each stored or provisional destination resource, by its literal. */
  readonly linkedResources: ReadonlyMap<string, LinkedResource>
  /**
   * `Type/<source id>` → `Type/<stored id>` for every decoded resource a stored
   * one stands in for, a second resource of the same identity under another id
   * included.
   */
  readonly literalRedirects: ReadonlyMap<string, string>
  /** What a referent's own resource assumes, by `Referent.key`: the identifiers of the referents linked to it. */
  readonly assumedByOwnResource: ReadonlyMap<string, readonly Identifier[]>
}

/** `accumulated` with `identifiers` appended under `key`. */
const accumulate = (
  accumulated: Map<string, readonly Identifier[]>,
  key: string,
  identifiers: readonly Identifier[]
): void => {
  accumulated.set(key, [...(accumulated.get(key) ?? []), ...identifiers])
}

/** The literals the decoded resources of `decodedFile` carry. */
const literalsHeldBy = (decodedFile: DecodedFile.DecodedFile): ReadonlySet<string> =>
  new Set(
    DecodedFile.resources(decodedFile).flatMap(({ resource }) =>
      resource.id === null ? [] : [`${resource.resourceType}/${resource.id}`]
    )
  )

/** The stored resource `resource`'s referent links to under `destinations`, when it links to one. */
const storedDestinationOf = (
  destinations: ReadonlyMap<string, Destination.Type>,
  resource: LinkableResource.Type
): Option.Option<LinkableResource.WithId> =>
  pipe(
    LinkableResource.identityOf(resource),
    Option.flatMapNullable((identity) => destinations.get(Identity.key(identity))),
    Option.filter(Destination.is('OnStoredResource')),
    Option.map(({ resource: stored }) => stored)
  )

/**
 * The plan for `decodedFile` under `choices`.
 *
 * @remarks
 * Every destination resource assumes, once, its own derived identifier (so a
 * name-and-birth-date match finds it next time, and so a second placement
 * adds nothing) and then the identifiers of every referent linked to it. A
 * referent's own resource assumes the identifiers of the referents linked to
 * it the same way.
 */
const make = (decodedFile: DecodedFile.DecodedFile, choices: LinkChoice.ByReferent): Type => {
  const referents = Referent.discover(decodedFile)
  const indexed = Referent.index(referents)
  const resolved = referents.map(
    (referent) => [referent, Resolution.destinationOf(choices, indexed, referent)] as const
  )
  const destinations = new Map(
    resolved.map(([referent, destination]) => [Referent.key(referent), destination])
  )

  const assumedByOwnResource = new Map<string, readonly Identifier[]>()
  const assumedByLiteral = new Map<string, readonly Identifier[]>()
  const linkedTo = new Map<
    string,
    { readonly resource: LinkableResource.WithId; readonly byMentionsOnly: boolean }
  >()
  const link = (resource: LinkableResource.WithId, referent: Referent.Type): void => {
    const literal = LinkableResource.literalOf(resource)
    const known = linkedTo.get(literal)
    if (known === undefined) {
      accumulate(
        assumedByLiteral,
        literal,
        Option.toArray(LinkableResource.derivedIdentifier(resource))
      )
    }
    accumulate(assumedByLiteral, literal, Referent.identifiersOf(referent))
    linkedTo.set(literal, {
      resource,
      byMentionsOnly: (known?.byMentionsOnly ?? true) && referent._tag === 'ByMentionOnly',
    })
  }
  for (const [referent, destination] of resolved) {
    Destination.match(destination, {
      Unlinked: () => undefined,
      OnOwnResource: ({ referent: own }) => {
        accumulate(assumedByOwnResource, Referent.key(own), Referent.identifiersOf(referent))
      },
      OnStoredResource: ({ resource }) => {
        link(resource, referent)
      },
      OnProvisionalResource: ({ resource }) => {
        link(resource, referent)
      },
    })
  }

  const held = literalsHeldBy(decodedFile)
  const linkedResources = new Map(
    [...linkedTo].map(([literal, { resource, byMentionsOnly }]): [string, LinkedResource] => {
      const assumed = assumedByLiteral.get(literal) ?? []
      return [
        literal,
        {
          resource: LinkableResource.assumesIdentifiers(resource, assumed),
          assumed,
          existsOnlyAsMentionInFile: byMentionsOnly && !held.has(literal),
        },
      ]
    })
  )

  const literalRedirects = new Map(
    DecodedFile.resources(decodedFile).flatMap(({ resource }) => {
      if (!LinkableResource.is(resource) || resource.id === null) return []
      const from = LinkableResource.literalOf({ ...resource, id: resource.id })
      return pipe(
        storedDestinationOf(destinations, resource),
        Option.map((stored) => [from, LinkableResource.literalOf(stored)] as const),
        Option.toArray
      )
    })
  )

  return { destinations, linkedResources, literalRedirects, assumedByOwnResource }
}

export { make, storedDestinationOf }
export type { LinkedResource, Type }
