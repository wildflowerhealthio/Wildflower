import type { Layer } from 'effect'
import type { MessageHandler } from 'effect-messaging-core'
import { expectTypeOf } from 'expect-type'

import type { useReceiverLayer } from './use-receiver-layer.ts'

// Type-only assertions on `useReceiverLayer`'s signature. Hoisted to
// module scope so the type check fires at file load — `expect-type` is
// purely compile-time, so wrapping these in `it(...)` would have Jest
// report them as passing whether or not the invariant holds.
expectTypeOf<ReturnType<typeof useReceiverLayer>>().toEqualTypeOf<
  Layer.Layer<MessageHandler.TagId<'Collector', 'Host'>>
>()
expectTypeOf<Parameters<typeof useReceiverLayer>>().toEqualTypeOf<[]>()

// Jest globbing requires at least one `describe`/`it` in any matched
// file — the assertions above carry the actual contract.
describe('useReceiverLayer (type-level)', () => {
  it('compiles', () => {
    expect(true).toBe(true)
  })
})
