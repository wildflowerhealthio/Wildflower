/**
 * A number a DICOM file states under its issuer, as the FHIR `Identifier` it
 * is keyed by.
 *
 * The issuer's Universal Entity ID becomes `Identifier.system` as IHE ITI
 * TF-2 Appendix Z.9.1.2 maps an HL7 v2 assigning authority
 * (https://profiles.ihe.net/ITI/TF/Volume2/ch-Z.html), spelled as FHIR's
 * Identifier data type spells an OID or a UUID (`urn:oid:`, `urn:uuid:`;
 * https://hl7.org/fhir/R4/datatypes.html#Identifier). What follows is
 * Wildflower's own: IHE expects a deployment to register a URI for each local
 * namespace, and FHIR leaves an identifier with no system meaningful only in
 * its local context. We keep no registry, and a key must have a system, so a
 * number whose issuer states no URI is keyed under a Wildflower-minted system
 * for that kind of number (`DicomIdentifierSystem`) with the local namespace
 * as `assigner.display`.
 *
 * @packageDocumentation
 */
import type { HierarchicDesignator } from '@wildflowerhealthio/dicom'
import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import type { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import { Match, Option, Schema } from 'effect'

/**
 * An ISO object identifier as HL7 v2's `ISO` type carries it: dot-separated
 * arcs, the first `0`–`2`, no leading zeros.
 */
const IsoOid = Schema.String.pipe(Schema.pattern(/^[0-2](\.(0|[1-9]\d*))+$/))

/**
 * The `Identifier.system` a Universal Entity ID names: `urn:oid:<id>` for an
 * `ISO` OID, `urn:uuid:<id>` for a `UUID`, the URI as `URL.href` spells it
 * for a `URI` that parses as one — the spelling a record's key is read back
 * in, so two spellings of one URI key one record. `None` for any other type (`DNS`, `X500`, …) and for a value
 * malformed for its type, which name no URI this can spell.
 */
const universalSystemOf = (
  universalEntityId: string,
  universalEntityIdType: string
): Option.Option<string> =>
  Match.value(universalEntityIdType.toUpperCase()).pipe(
    Match.when('ISO', () =>
      Option.map(Schema.decodeUnknownOption(IsoOid)(universalEntityId), (oid) => `urn:oid:${oid}`)
    ),
    Match.when('UUID', () =>
      Option.map(
        Schema.decodeUnknownOption(Schema.UUID)(universalEntityId),
        (uuid) => `urn:uuid:${uuid.toLowerCase()}`
      )
    ),
    Match.when('URI', () =>
      Option.map(Schema.decodeUnknownOption(Schema.URL)(universalEntityId), (url) => url.href)
    ),
    Match.orElse(() => Option.none())
  )

/** The system the issuer's Universal Entity ID names, `None` when it states none or one naming no URI. */
const universalSystemOfIssuer = (
  issuer: HierarchicDesignator.Type | undefined
): Option.Option<string> =>
  Option.flatMap(Option.fromNullable(issuer?.universalEntityId), (id) =>
    Option.flatMap(Option.fromNullable(issuer?.universalEntityIdType), (type) =>
      universalSystemOf(id, type)
    )
  )

/**
 * What is wrong with the issuer's Universal Entity ID when it states one that
 * names no URI: `<id> with no Universal Entity ID Type (0040,0033)` when the
 * type is missing, else `<id> (<type>), which names no URI`. What the decode
 * notes, since the number is then keyed as one whose issuer the file does not
 * state.
 */
const unresolvedUniversalIssuerOf = (
  issuer: HierarchicDesignator.Type | undefined
): Option.Option<string> =>
  Option.isSome(universalSystemOfIssuer(issuer))
    ? Option.none()
    : Option.map(Option.fromNullable(issuer?.universalEntityId), (id) =>
        issuer?.universalEntityIdType === undefined
          ? `${id} with no Universal Entity ID Type (0040,0033)`
          : `${id} (${issuer.universalEntityIdType}), which names no URI`
      )

/**
 * A number under its issuer: the record key it is, the name its issuer is
 * displayed by when the issuer is not that key's system, and what kept a
 * stated universal issuer from being that system
 * ({@link unresolvedUniversalIssuerOf}).
 */
interface IssuedIdentifier {
  readonly key: DetachedResource.Key
  readonly assignerDisplay: Option.Option<string>
  readonly unresolvedIssuer: Option.Option<string>
}

/**
 * Key `value` under the issuer the file states for it.
 *
 * @param value - The number as the file states it (a Patient ID, an Accession
 *   Number)
 * @param issuer - Who issued it, when the file says: its local namespace and
 *   its universal id
 * @param unstatedIssuerSystem - The system for a number whose issuer the file
 *   does not state as a URI
 * @returns The number under its universal issuer's URI when the file states
 *   one this resolves, else under `unstatedIssuerSystem`; the assigner
 *   displayed is the local namespace, else a Universal Entity ID that did not
 *   resolve, as written
 *
 * @remarks
 * A local namespace alone is not a URI: two files whose issuers are named
 * only locally key one number under one system, whatever the namespace.
 */
const issuedIdentifierOf = (
  value: string,
  issuer: HierarchicDesignator.Type | undefined,
  unstatedIssuerSystem: string
): IssuedIdentifier => {
  const universalEntityId = Option.fromNullable(issuer?.universalEntityId)
  const universalSystem = universalSystemOfIssuer(issuer)
  return {
    key: { system: Option.getOrElse(universalSystem, () => unstatedIssuerSystem), value },
    assignerDisplay: Option.orElse(Option.fromNullable(issuer?.localNamespaceEntityId), () =>
      Option.isSome(universalSystem) ? Option.none() : universalEntityId
    ),
    unresolvedIssuer: unresolvedUniversalIssuerOf(issuer),
  }
}

/** The identifier wire of an {@link IssuedIdentifier}: its key, and its assigner when it has one. */
const issuedIdentifierWire = ({
  key,
  assignerDisplay,
}: IssuedIdentifier): typeof IdentifierAndReference.IdentifierSchema.Encoded => ({
  ...DetachedResource.keyIdentifierWire(key),
  ...Option.match(assignerDisplay, {
    onNone: () => ({}),
    onSome: (display) => ({ assigner: { display } }),
  }),
})

export { issuedIdentifierOf, issuedIdentifierWire, unresolvedUniversalIssuerOf, universalSystemOf }
export type { IssuedIdentifier }
