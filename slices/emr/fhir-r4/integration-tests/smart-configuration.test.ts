import { Effect } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import { ORIGIN, wireServerScoped } from './server-helpers.ts'

describe('GET /.well-known/smart-configuration', () => {
  test('serves a SMART config that decodes against SmartConfigurationSchema', () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const wired = yield* wireServerScoped
          // The typed client decodes the response body against
          // `SmartConfigurationSchema`, so a successful return value already
          // proves required fields are present and parseable. We additionally
          // pin a few values to catch silent regressions in `makeSmartConfiguration`.
          const config = yield* wired.public['smart-well-known'].SmartConfiguration()

          expect(config.issuer).toBe(`${ORIGIN}/fhir-r4`)
          expect(config.token_endpoint).toBe(`${ORIGIN}/auth/token`)
          expect(config.authorization_endpoint).toBe(`${ORIGIN}/auth/authorize`)
          expect(config.grant_types_supported).toContain('authorization_code')
          expect(config.code_challenge_methods_supported).toContain('S256')
          expect(config.capabilities).toContain('launch-ehr')
        })
      )
    ))
})
