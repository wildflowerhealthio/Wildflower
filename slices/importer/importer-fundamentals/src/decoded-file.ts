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

export { resources }

export type { Resource, Section, DecodedFile }
