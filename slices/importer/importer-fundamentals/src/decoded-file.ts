import type { FhirResourceWithId } from '@wildflowerhealthio/fhir-r4/resources'

/**
 * Where a reviewed record came from. `Decoded`: the record as a source holds
 * it, read out of a picked file (or, beside the files, a set's source file
 * or a stored record the batch links to). `Implied`: built by the import
 * from a reference to a record no file of its set holds
 * (`DecodedFileSet.adopt`), so it says only what that reference said of it.
 */
type Origin = 'Decoded' | 'Implied'

/**
 * One reviewed resource: its review key, its title, the resource, which has
 * an id to be written under, and where it came from.
 */
interface Resource {
  readonly key: string
  readonly title: string
  readonly resource: FhirResourceWithId
  readonly origin: Origin
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

export type { DecodedFile, Origin, Resource, Section }
