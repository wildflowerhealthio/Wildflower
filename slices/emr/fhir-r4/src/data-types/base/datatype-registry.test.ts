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

  describe('positiveInt', () => {
    const positiveIntExtension = (
      value: number
    ): { readonly url: string; readonly valuePositiveInt: number } => ({
      url: 'http://example.org/ext/count',
      valuePositiveInt: value,
    })

    test('round-trips a positive integer', () => {
      const decoded = Schema.decodeSync(Extension.Schema)(positiveIntExtension(3))
      expect(decoded.valuePositiveInt).toBe(3)
      expect(Schema.encodeSync(Extension.Schema)(decoded)).toMatchObject({ valuePositiveInt: 3 })
    })

    test('decodes a zero rather than failing the resource that carries it', () => {
      // A `value[x]` slot lives inside an `Extension` inside a resource, so a
      // rejection here fails the whole enclosing resource — which a caller that
      // unions over resource types can only observe as the resource vanishing.
      // Vendors do send `valuePositiveInt: 0` (carebook's remaining-repeats
      // dual-write); a zero-repeat prescription must not delete a medication.
      expect(Schema.decodeSync(Extension.Schema)(positiveIntExtension(0)).valuePositiveInt).toBe(0)
    })

    test('still rejects a non-integer', () => {
      expect(() => Schema.decodeSync(Extension.Schema)(positiveIntExtension(1.5))).toThrow()
    })
  })
})
