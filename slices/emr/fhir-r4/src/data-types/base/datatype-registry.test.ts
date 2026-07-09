import { Effect, Schema } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

// side-effect: the data-types barrel re-exports every complex datatype
// module, triggering their `registerDatatypeSchema(...)` self-registrations.
import '../index.ts'
import * as Extension from '../special-purpose/extension.ts'
import { baseDatatypes, registeredNames, resolveDatatypeSchema } from './datatype-registry.ts'
import * as Datatype from './datatype.ts'

describe('fhir-r4 datatype registry', () => {
  test.each(registeredNames)('%s is registered after barrel load', (name) => {
    expect(baseDatatypes[name]).toBeDefined()
    expect(Effect.runSyncExit(resolveDatatypeSchema(name))._tag).toBe('Success')
  })

  describe('value[x] unregistered slot behavior', () => {
    const unregisteredNames = Datatype.names.filter((n) => !(n in baseDatatypes))

    test('there are unregistered names to exercise', () => {
      expect(unregisteredNames.length).toBeGreaterThan(0)
    })

    test.each(unregisteredNames)('value%s decodes wire content to null', (name) => {
      const key = `value${name.charAt(0).toUpperCase()}${name.slice(1)}`
      const wire = {
        url: 'http://example.org/ext/unregistered',
        [key]: { arbitrary: 'wire content' },
      }
      const decoded = Schema.decodeSync(Extension.Schema)(wire)
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- key is a value[x] slot constructed from `name` at runtime
      expect((decoded as unknown as Record<string, unknown>)[key]).toBeNull()
    })

    test.each(unregisteredNames)('value%s rejects non-null in-memory input on encode', (name) => {
      const key = `value${name.charAt(0).toUpperCase()}${name.slice(1)}`
      const extension = {
        ...Extension.emptyValueChoice,
        id: null,
        extension: [],
        url: 'http://example.org/ext/unregistered',
        [key]: { anything: 'non-null' },
      }
      expect(() =>
        Schema.encodeSync(Extension.Schema)(
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- intentionally construct an unregistered-slot extension to exercise the encode failure path
          extension as unknown as typeof Extension.Schema.Type
        )
      ).toThrow()
    })
  })
})
