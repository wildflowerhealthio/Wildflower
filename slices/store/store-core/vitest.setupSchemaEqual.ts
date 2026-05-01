import { Schema } from 'effect'
import { expect } from 'vite-plus/test'

expect.extend({
  toSchemaEqual<A, I>(received: A, schema: Schema.Schema<A, I>, expected: A) {
    const eq = Schema.equivalence(schema)
    const pass = eq(received, expected)
    const message = (): string => {
      if (pass) {
        return 'Values are schema-equivalent.'
      }
      return `Values are not schema-equivalent.\nreceived: ${JSON.stringify(received)}\nexpected: ${JSON.stringify(expected)}`
    }
    return {
      pass,
      message,
      actual: received,
      expected,
    }
  },
})
