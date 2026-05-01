import { State } from '@livestore/livestore'
import type { Arbitrary, FastCheck } from 'effect'
import { Schema, pipe } from 'effect'
import { AnnotateArrayWithArbitrary, PermissivePassthrough } from 'kitchen-sink/schema'
import { Extension, Narrative, Resource } from '../schemas/index.ts'

const columns = {
  ...Resource.columns,
  /**
   * Text summary of the resource, for human interpretation
   */
  text: State.SQLite.json({
    nullable: true,
    schema: Narrative.Schema,
  }),
  /**
   * Contained, inline Resources
   */
  contained: State.SQLite.json({
    schema: Schema.Array(PermissivePassthrough).pipe(AnnotateArrayWithArbitrary({ maxLength: 0 })),
  }),
  /**
   * Additional content defined by implementations
   */
  extension: State.SQLite.json({
    schema: pipe(
      Schema.Array(Extension.Schema),
      Schema.annotations({
        arbitrary:
          (): Arbitrary.LazyArbitrary<readonly Extension.Type[]> => (fc: typeof FastCheck) =>
            fc.constant([]),
      })
    ),
  }),
  /**
   * Extensions that cannot be ignored
   */
  modifierExtension: State.SQLite.json({
    schema: pipe(
      Schema.Array(Extension.Schema),
      Schema.annotations({
        arbitrary:
          (): Arbitrary.LazyArbitrary<readonly Extension.Type[]> => (fc: typeof FastCheck) =>
            fc.constant([]),
      })
    ),
  }),
}

export { columns }
