import { Schema } from 'effect'

import type { DatatypeName, baseDatatypes } from '../datatype.ts'
import { Extension } from './extension.ts'

/** Extracts the decoded value type for a specific datatype tag from the choice union. */
type DatatypeValueFor<Tag extends DatatypeName> = {
  _tag: Tag
} & Record<Tag, Extract<typeof baseDatatypes, { _tag: Tag }>[Tag]>

/*
{
  "resourceType": "StructureDefinition",
  "url": "http://hl7.org/fhir/StructureDefinition/data-absent-reason",
  "name": "Data Absent Reason",
  "kind": "complex-type",
  "type": "Extension",
  "baseDefinition": "http://hl7.org/fhir/StructureDefinition/Extension"
}
*/
// oxlint-disable-next-line @typescript-eslint/no-unused-vars
const StructureDefinitionKind = Schema.Enums({
  'complex-type': 'complex-type',
  logical: 'logical',
  'primitive-type': 'primitive-type',
  resource: 'resource',
})
// oxlint-disable-next-line @typescript-eslint/no-unused-vars
const StructureDefinitionType = Schema.Enums({ Extension: 'Extension' })

/**
 * Describes a FHIR StructureDefinition for an Extension profile. Provides
 * `getValues` and `withValues` to read/write typed extension values on
 * resources without manually traversing the `extension` array.
 *
 * @typeParam Tag - The data type name this definition targets (e.g. `'dateTime'`),
 *   or `null` if it carries no value (container-only extension)
 */
export class StructureDefinition<Tag extends DatatypeName | null = null> {
  static readonly extensionBaseDefinitionUrl = 'http://hl7.org/fhir/StructureDefinition/Extension'
  url: string
  name: string
  kind: typeof StructureDefinitionKind.Type
  type: typeof StructureDefinitionType.Type
  baseDefinition: string
  relevantField: Tag

  constructor(args: {
    url: string
    name: string
    kind: typeof StructureDefinitionKind.Type
    type: typeof StructureDefinitionType.Type
    relevantField: Tag
    baseDefinition: string
  }) {
    this.url = args.url
    this.name = args.name
    this.kind = args.kind
    this.type = args.type
    this.baseDefinition = args.baseDefinition
    this.relevantField = args.relevantField
  }

  /**
   * Extracts all values for this extension from a resource's `extension` array.
   *
   * @param resource - Any object with an `extension` array
   * @returns Array of typed values from matching extensions
   */
  getValues(resource: {
    extension?: readonly Extension[]
  }): readonly DatatypeValueFor<NonNullable<Tag>>[] {
    const { relevantField } = this
    if (relevantField === null) {
      return []
    }
    if (!resource.extension) {
      return []
    }

    return resource.extension
      .filter(
        (ext): ext is Extension & { value: DatatypeValueFor<NonNullable<Tag>> } =>
          ext.url === this.url && ext.value?._tag === relevantField
      )
      .map((ext) => ext.value[relevantField])
  }

  /**
   * Returns a copy of `resource` with its extension array updated to contain
   * the given values for this definition. Existing extensions with other URLs
   * are preserved; existing extensions with this URL are replaced.
   */
  withValues<
    T extends {
      extension?: readonly Extension[]
    },
  >(resource: T, values: readonly DatatypeValueFor<NonNullable<Tag>>[]): T {
    const { relevantField } = this
    if (relevantField === null) {
      return resource
    }
    const existingExtensions = resource.extension?.filter((ext) => ext.url !== this.url) ?? []

    const newExtensions = [
      ...existingExtensions,
      ...values.map((value) =>
        Extension.make({
          url: this.url,
          value: Extension.ValueChoice.make(
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion
            { _tag: relevantField, [relevantField]: value } as typeof Extension.ValueChoice.Encoded
          ),
        })
      ),
    ]

    return {
      ...resource,
      extension: newExtensions,
    }
  }
}
