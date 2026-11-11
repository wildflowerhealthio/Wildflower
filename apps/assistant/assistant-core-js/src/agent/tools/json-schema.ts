/**
 * JSON Schema pieces the tool definitions share.
 *
 * @packageDocumentation
 */

/** The JSON Schema of a string that is one of `values`. */
const enumOf = (values: readonly string[], description: string): Record<string, unknown> => ({
  type: 'string',
  enum: values,
  description,
})

export { enumOf }
