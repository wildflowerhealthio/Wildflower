import type { FhirResource } from 'fhir-r4/resources'

interface Resource {
  readonly key: string
  readonly title: string
  readonly resource: FhirResource
}

interface Section {
  readonly title: string
  readonly resources: readonly Resource[]
}

interface DecodedFile {
  readonly sections: readonly Section[]
  readonly notes: readonly string[]
}

const resources = (decodedFile: { readonly sections: readonly Section[] }): readonly Resource[] =>
  decodedFile.sections.flatMap((section) => section.resources)

/**
 * Prefix every review key in a decoded file, so one file's keys cannot
 * collide with another's once the batch merges their sections.
 *
 * @param decodedFile - One file's decode, keyed within itself
 * @param prefix - The file's key namespace, from `FormatDecode.keyPrefix` (whose module remarks say why)
 * @returns The same sections and notes with every resource key prefixed
 */
const namespaceKeys = (decodedFile: DecodedFile, prefix: string): DecodedFile => ({
  ...decodedFile,
  sections: decodedFile.sections.map((section) => ({
    ...section,
    resources: section.resources.map((resource) => ({
      ...resource,
      key: `${prefix}${resource.key}`,
    })),
  })),
})

export { namespaceKeys, resources }

export type { Resource, Section, DecodedFile }
