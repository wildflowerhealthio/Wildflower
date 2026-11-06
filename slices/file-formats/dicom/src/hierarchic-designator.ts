/**
 * DICOM's HL7v2 Hierarchic Designator (PS3.3 Table 10-17): who issued an
 * identifier, as one item of an issuer sequence states it.
 *
 * @packageDocumentation
 */

/**
 * One issuer sequence item's three designator attributes, each as the file
 * writes it, or `undefined` when the item leaves it out.
 *
 * @remarks
 * The values are raw: what a Universal Entity ID names, and whether its type
 * is one a FHIR `Identifier.system` can be spelled from, is the reader's to
 * decide. A designator this package returns states at least one of the three.
 */
interface Type {
  /** Local Namespace Entity ID (0040,0031): the issuer's local name, HL7 v2 HD.1. */
  readonly localNamespaceEntityId: string | undefined
  /** Universal Entity ID (0040,0032): the issuer's universal id, HL7 v2 HD.2. */
  readonly universalEntityId: string | undefined
  /**
   * Universal Entity ID Type (0040,0033): what kind of id `universalEntityId`
   * is (`ISO`, `UUID`, `URI`, `DNS`, …), HL7 v2 HD.3.
   */
  readonly universalEntityIdType: string | undefined
}

export { type Type }
