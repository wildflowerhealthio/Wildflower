import { Schema } from 'effect'
import { expect } from 'vite-plus/test'

declare global {
  var setupInitialized: boolean | undefined
}

if (!globalThis.setupInitialized) {
  expect.extend({
    toSchemaEqual<A, I>(received: A, schema: Schema.Schema<A, I>, expected: A) {
      if (schema !== undefined) {
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
      }
      try {
        expect(received).toEqual(expected)
        return {
          pass: true,
          message: (): string => 'Values are deeply equal.',
          actual: received,
          expected,
        }
      } catch (error) {
        const message = (): string => {
          if (error instanceof Error) {
            return error.message
          }
          return String(error)
        }
        return {
          pass: false,
          message,
          actual: received,
          expected,
        }
      }
    },
  })

  globalThis.setupInitialized = true
}
