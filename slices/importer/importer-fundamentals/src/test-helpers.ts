/**
 * Test fixtures for a format binding's own tests, published so each binding
 * asserts the same things the same way.
 *
 * @packageDocumentation
 */
import * as DecodedFileSet from './decoded-file-set.ts'

/** A section that keeps its records as their source gave them. */
type FromSourceSection = Extract<DecodedFileSet.Section, { readonly _tag: 'FromSource' }>

/**
 * A decode's sections, each a `FromSource` one: throws on an `Adopted`
 * section, for the tests of a decoder that keeps every record as its source
 * gave it, for the import stage to adopt.
 */
const fromSourceSectionsOf = (decoded: {
  readonly sections: readonly DecodedFileSet.Section[]
}): readonly FromSourceSection[] =>
  decoded.sections.map(
    DecodedFileSet.Section.$match({
      Adopted: ({ title }): FromSourceSection => {
        throw new Error(
          `section "${title}" is Adopted: expected the records as their source gave them`
        )
      },
      FromSource: (section) => section,
    })
  )

export { fromSourceSectionsOf }
export type { FromSourceSection }
