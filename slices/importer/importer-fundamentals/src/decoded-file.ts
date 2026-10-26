import type { FhirResource } from '@wildflowerhealthio/fhir-r4/resources'

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

/**
 * `decodedFile` with `f` applied to every resource entry, sections and notes
 * kept. A section and the file come back as the same object when `f` returns
 * every entry in them as itself.
 */
const mapResources = (decodedFile: DecodedFile, f: (entry: Resource) => Resource): DecodedFile => {
  const sections = decodedFile.sections.map((section) => {
    const entries = section.resources.map(f)
    return entries.every((entry, at) => entry === section.resources[at])
      ? section
      : { ...section, resources: entries }
  })
  return sections.every((section, at) => section === decodedFile.sections[at])
    ? decodedFile
    : { ...decodedFile, sections }
}

export { mapResources, namespaceKeys, resources }

export type { Resource, Section, DecodedFile }
