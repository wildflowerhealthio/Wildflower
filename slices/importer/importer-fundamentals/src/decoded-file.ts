interface Resource<TParsed> {
  readonly key: string
  readonly title: string
  readonly resource: TParsed
}

interface Section<TParsed> {
  readonly title: string
  readonly resources: readonly Resource<TParsed>[]
}

interface DecodedFile<TParsed> {
  readonly sections: readonly Section<TParsed>[]
  readonly notes: readonly string[]
}

const resources = <TParsed>(decodedFile: {
  readonly sections: readonly Section<TParsed>[]
}): readonly Resource<TParsed>[] => decodedFile.sections.flatMap((section) => section.resources)

export { resources }

export type { Resource, Section, DecodedFile }
