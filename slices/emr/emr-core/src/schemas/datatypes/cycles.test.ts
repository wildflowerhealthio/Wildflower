import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import * as Extension from './extension.ts'
import * as Period from './period.ts'
import * as Quantity from './quantity.ts'
import * as Reference from './reference.ts'

// ---------------------------------------------------------------------------
// Property-based tests for the Element ⇌ Extension type cycle.
//
// The cycle is mediated by:
//   - `Extension.extension: readonly Extension[]`        (self-recursion)
//   - `Extension.value[x]` carrying datatypes that themselves extend Element
//     (e.g. `Quantity`, `Period`, `Reference`)
//
// Runtime resolution relies on `Schema.suspend(() => baseDatatypes[name].schema())`
// inside `ChoiceElementSet.SchemaFields`. These tests exercise that the suspend
// closures resolve to the strict registered schemas, not the
// `PermissivePassthrough` fallback, so cyclic round-trips preserve value
// identity.
// ---------------------------------------------------------------------------

const decodeExtension = Schema.decodeSync(Extension.Schema)
const encodeExtension = Schema.encodeSync(Extension.Schema)

/** Reusable empty `value[x]` slate. */
const emptyValueChoice = Extension.emptyValueChoice

// ---------------------------------------------------------------------------
// Self-recursion: nested `extension` arrays of arbitrary depth
// ---------------------------------------------------------------------------

/**
 * Depth-bounded recursive Extension arbitrary. The schema-level arbitrary
 * annotation forces `extension: []` to keep `Arbitrary.make` tractable, so we
 * build an explicit recursive arbitrary here to actually exercise nesting.
 */
const { node: recursiveExtensionArb } = fc.letrec<{
  node: Schema.Schema.Type<typeof Extension.Schema>
}>((tie) => ({
  node: fc
    .tuple(
      Arbitrary.make(Extension.Schema),
      fc.option(fc.array(tie('node'), { maxLength: 2 }), { nil: undefined })
    )
    .map(([base, children]) => {
      if (children === undefined) return base
      return { ...base, extension: children }
    }),
}))

describe('Extension self-recursion', () => {
  test('property: arbitrary depth-bounded nesting round-trips', () => {
    fc.assert(
      fc.property(recursiveExtensionArb, (ext) => {
        const encoded = encodeExtension(ext)
        const decoded = decodeExtension(encoded)
        expect(decoded).toSchemaEqual(Extension.Schema, ext)
      }),
      { numRuns: numRunsFor(20) }
    )
  }, 30_000)
})

// ---------------------------------------------------------------------------
// value[x] cycles — Extension carrying a datatype that extends Element
//
// Each case picks a single `value[x]` field, generates an arbitrary value via
// the registered strict schema, wraps it in an Extension, and round-trips.
// ---------------------------------------------------------------------------

interface ValueCycleCase<K extends keyof Schema.Schema.Type<typeof Extension.Schema>, A, I> {
  readonly field: K
  readonly schema: Schema.Schema<
    A & Schema.Schema.Type<typeof Extension.Schema>[K],
    I & Schema.Schema.Encoded<typeof Extension.Schema>[K]
  >
  readonly url: string
}

const runValueCycle = <K extends keyof Schema.Schema.Type<typeof Extension.Schema>, A, I>({
  field,
  schema,
  url,
}: ValueCycleCase<K, A, I>): void => {
  fc.assert(
    fc.property(Arbitrary.make(schema), (value) => {
      const ext = {
        ...emptyValueChoice,
        id: null,
        extension: [],
        url,
        [field]: value,
      } as Schema.Schema.Type<typeof Extension.Schema>
      const decoded = decodeExtension(encodeExtension(ext))
      const decodedValue = decoded[field]
      expect(decodedValue).toSchemaEqual(schema, value)
    }),
    { numRuns: numRunsFor(30) }
  )
}

describe('Extension value[x] cycles', () => {
  test('valueQuantity round-trips', () => {
    runValueCycle({
      field: 'valueQuantity',
      schema: Quantity.Schema,
      url: 'http://test/quantity',
    })
  })

  // Reference embeds Identifier (which embeds Reference back) — the cyclic
  // arbitrary is the slow one in this file; bump the timeout for headroom
  // under `vp run -r test` contention.
  test('valueReference round-trips', () => {
    runValueCycle({
      field: 'valueReference',
      schema: Reference.Schema,
      url: 'http://test/reference',
    })
  }, 30_000)

  test('valuePeriod round-trips', () => {
    runValueCycle({
      field: 'valuePeriod',
      schema: Period.Schema,
      url: 'http://test/period',
    })
  })
})

// ---------------------------------------------------------------------------
// Composite cycle — nested extension carrying a value[x] datatype at depth 2
// ---------------------------------------------------------------------------

describe('Extension composite cycle', () => {
  test('property: nested Extension carrying valueQuantity round-trips', () => {
    fc.assert(
      fc.property(Arbitrary.make(Quantity.Schema), (quantity) => {
        const inner: Schema.Schema.Type<typeof Extension.Schema> = {
          ...emptyValueChoice,
          id: null,
          extension: [],
          url: 'http://test/inner',
          valueQuantity: quantity,
        }
        const outer: Schema.Schema.Type<typeof Extension.Schema> = {
          ...emptyValueChoice,
          id: null,
          extension: [inner],
          url: 'http://test/outer',
        }
        const decoded = decodeExtension(encodeExtension(outer))
        expect(decoded.extension[0]?.valueQuantity).toSchemaEqual(Quantity.Schema, quantity)
      }),
      { numRuns: numRunsFor(30) }
    )
  })
})
