import type { CollectorBridge } from 'collector-fundamentals/bridge'
import type { MessageHandler } from 'effect-messaging-core'
import { expectTypeOf } from 'expect-type'

import type { useCollectorHostHandlers } from './use-host-handlers.ts'

// Type-only assertions on `useCollectorHostHandlers`'s signature.
// Hoisted to module scope so the type check fires at file load —
// `expect-type` is purely compile-time, so wrapping these in `it(...)`
// would have Jest report them as passing whether or not the invariant
// holds.
expectTypeOf<ReturnType<typeof useCollectorHostHandlers>>().toEqualTypeOf<
  MessageHandler.HandlersFor<CollectorBridge['WebToHost']>
>()
expectTypeOf<Parameters<typeof useCollectorHostHandlers>>().toEqualTypeOf<[]>()

// Jest globbing requires at least one `describe`/`it` in any matched
// file — the assertions above carry the actual contract.
describe('useCollectorHostHandlers (type-level)', () => {
  it('compiles', () => {
    expect(true).toBe(true)
  })
})
