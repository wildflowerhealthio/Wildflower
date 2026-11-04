import type { FhirResourceWithId } from '@wildflowerhealthio/fhir-r4/resources'

/** One reviewed resource: its review key, its title, and the resource, which has an id to be written under. */
interface Resource {
  readonly key: string
  readonly title: string
  readonly resource: FhirResourceWithId
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

export { mapResources, resources }

export type { Resource, Section, DecodedFile }
