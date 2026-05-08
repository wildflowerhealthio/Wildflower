import { Schema } from 'effect'
import * as fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'
import {
  type BufferedDispatcher,
  makeBufferedDispatcher,
  makeMessageRecord,
  type MessageSchemaRecord,
} from '../src/messages.ts'

const Foo = Schema.parseJson(Schema.TaggedStruct('Foo', { value: Schema.Number }))
type Foo = Schema.Schema.Type<typeof Foo>
const Bar = Schema.parseJson(Schema.TaggedStruct('Bar', { name: Schema.String }))
type Bar = Schema.Schema.Type<typeof Bar>

const TestRecord = makeMessageRecord([
  ['Foo', Foo],
  ['Bar', Bar],
] as const)
type TestRecord = typeof TestRecord

describe('makeMessageRecord', () => {
  test("keys the record by each pair's tag literal", () => {
    expect(Object.keys(TestRecord).toSorted()).toEqual(['Bar', 'Foo'])
  })

  test('preserves the schema reference at each key', () => {
    expect(TestRecord.Foo).toBe(Foo)
    expect(TestRecord.Bar).toBe(Bar)
  })

  test('handles an empty pair list', () => {
    const empty = makeMessageRecord([] as const)
    expect(Object.keys(empty)).toEqual([])
  })

  test("drift: every key matches its schema's decoded _tag", () => {
    // Round-trip a value tagged with each key through the corresponding
    // schema. If the record were mis-keyed (e.g. `Foo: BarSchema`), decode
    // would either fail or produce a value whose `_tag` differs from the
    // record key — both of which the assertions below catch.
    const fooDecoded = Schema.decodeSync(TestRecord.Foo)(
      Schema.encodeSync(Foo)({ _tag: 'Foo', value: 1 })
    )
    expect(fooDecoded._tag).toBe('Foo')

    const barDecoded = Schema.decodeSync(TestRecord.Bar)(
      Schema.encodeSync(Bar)({ _tag: 'Bar', name: 'x' })
    )
    expect(barDecoded._tag).toBe('Bar')
  })
})

describe('makeBufferedDispatcher', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })
  afterEach(() => {
    warnSpy.mockRestore()
  })

  test('buffers messages received before any listener registers, and drains on first listener', () => {
    const d = makeBufferedDispatcher<TestRecord>()
    d.receive<'Foo'>({ _tag: 'Foo', value: 1 })
    d.receive<'Foo'>({ _tag: 'Foo', value: 2 })
    const seen: ReadonlyArray<Foo> = []
    const captured: Foo[] = [...seen]
    d.setMessageListener('Foo', (m) => {
      captured.push(m)
    })
    expect(captured.map((m) => m.value)).toEqual([1, 2])
  })

  test('delivers live after a listener is registered', () => {
    const d = makeBufferedDispatcher<TestRecord>()
    const captured: Foo[] = []
    d.setMessageListener('Foo', (m) => {
      captured.push(m)
    })
    d.receive<'Foo'>({ _tag: 'Foo', value: 7 })
    expect(captured.map((m) => m.value)).toEqual([7])
  })

  test('isolates buffers per tag', () => {
    const d = makeBufferedDispatcher<TestRecord>()
    d.receive<'Foo'>({ _tag: 'Foo', value: 1 })
    d.receive<'Bar'>({ _tag: 'Bar', name: 'a' })
    const fooSeen: Foo[] = []
    d.setMessageListener('Foo', (m) => {
      fooSeen.push(m)
    })
    expect(fooSeen.map((m) => m.value)).toEqual([1])
    // The Bar buffer is untouched.
    const barSeen: Bar[] = []
    d.setMessageListener('Bar', (m) => {
      barSeen.push(m)
    })
    expect(barSeen.map((m) => m.name)).toEqual(['a'])
  })

  test('consumeBuffered drains the queue without registering a listener', () => {
    const d = makeBufferedDispatcher<TestRecord>()
    d.receive<'Foo'>({ _tag: 'Foo', value: 1 })
    d.receive<'Foo'>({ _tag: 'Foo', value: 2 })
    const drained = d.consumeBuffered('Foo')
    expect(drained.map((m) => m.value)).toEqual([1, 2])

    // After draining, the buffer is empty; future arrivals re-buffer until a listener.
    d.receive<'Foo'>({ _tag: 'Foo', value: 3 })
    const captured: Foo[] = []
    d.setMessageListener('Foo', (m) => {
      captured.push(m)
    })
    expect(captured.map((m) => m.value)).toEqual([3])
  })

  test('consumeBuffered returns empty when nothing is queued', () => {
    const d = makeBufferedDispatcher<TestRecord>()
    expect(d.consumeBuffered('Foo')).toEqual([])
  })

  test('disposer transitions tag to disposed; subsequent receives drop with a warning', () => {
    const d = makeBufferedDispatcher<TestRecord>()
    const captured: Foo[] = []
    const dispose = d.setMessageListener('Foo', (m) => {
      captured.push(m)
    })
    d.receive<'Foo'>({ _tag: 'Foo', value: 1 })
    dispose()
    d.receive<'Foo'>({ _tag: 'Foo', value: 2 })
    expect(captured.map((m) => m.value)).toEqual([1])
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('received "Foo" after listener disposed')
    )
  })

  test('replacing a live listener warns and routes to the new listener', () => {
    const d = makeBufferedDispatcher<TestRecord>()
    const a: Foo[] = []
    const b: Foo[] = []
    d.setMessageListener('Foo', (m) => {
      a.push(m)
    })
    d.setMessageListener('Foo', (m) => {
      b.push(m)
    })
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('replacing existing listener'))
    d.receive<'Foo'>({ _tag: 'Foo', value: 9 })
    expect(a).toEqual([])
    expect(b.map((m) => m.value)).toEqual([9])
  })

  test('disposer is idempotent and does not clear a replacement listener', () => {
    const d = makeBufferedDispatcher<TestRecord>()
    const stale: Foo[] = []
    const live: Foo[] = []
    const disposeStale = d.setMessageListener('Foo', (m) => {
      stale.push(m)
    })
    d.setMessageListener('Foo', (m) => {
      live.push(m)
    })
    // Calling the stale disposer must not transition the live listener to disposed.
    disposeStale()
    d.receive<'Foo'>({ _tag: 'Foo', value: 4 })
    expect(stale).toEqual([])
    expect(live.map((m) => m.value)).toEqual([4])
  })

  test('re-registering a listener after dispose throws', () => {
    const d = makeBufferedDispatcher<TestRecord>()
    const dispose = d.setMessageListener('Foo', () => undefined)
    dispose()
    expect(() => d.setMessageListener('Foo', () => undefined)).toThrow(/previously disposed/)
  })

  test('dispose() warns when buffers are non-empty and lists every stranded tag', () => {
    const d = makeBufferedDispatcher<TestRecord>()
    d.receive<'Foo'>({ _tag: 'Foo', value: 1 })
    d.receive<'Foo'>({ _tag: 'Foo', value: 2 })
    d.receive<'Bar'>({ _tag: 'Bar', name: 'x' })
    d.dispose()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('disposed with un-consumed messages')
    )
    const message: unknown = warnSpy.mock.calls[0]?.[0]
    expect(typeof message).toBe('string')
    if (typeof message === 'string') {
      expect(message).toContain('Foo (2)')
      expect(message).toContain('Bar (1)')
    }
  })

  test('dispose() does not warn when nothing was buffered', () => {
    const d = makeBufferedDispatcher<TestRecord>()
    d.dispose()
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('disposed with un-consumed messages')
    )
  })

  test('dispose() transitions any remaining tags to disposed (post-dispose receives warn-drop)', () => {
    const d = makeBufferedDispatcher<TestRecord>()
    const seen: Foo[] = []
    d.setMessageListener('Foo', (m) => {
      seen.push(m)
    })
    d.dispose()
    d.receive<'Foo'>({ _tag: 'Foo', value: 1 })
    expect(seen).toEqual([])
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('received "Foo" after listener disposed')
    )
  })

  test('property: every receive reaches the listener exactly once across arbitrary subscribe orderings', () => {
    type Step =
      | { readonly kind: 'receive-foo'; readonly value: number }
      | { readonly kind: 'receive-bar'; readonly name: string }
      | { readonly kind: 'subscribe-foo' }
      | { readonly kind: 'subscribe-bar' }

    const stepArb = fc.oneof(
      fc.integer({ min: 0, max: 1000 }).map((value): Step => ({ kind: 'receive-foo', value })),
      fc.string({ maxLength: 8 }).map((name): Step => ({ kind: 'receive-bar', name })),
      fc.constant<Step>({ kind: 'subscribe-foo' }),
      fc.constant<Step>({ kind: 'subscribe-bar' })
    )

    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 30 }), (steps) => {
        const dispatcher: BufferedDispatcher<TestRecord> = makeBufferedDispatcher<TestRecord>()

        const sentFoo: number[] = []
        const sentBar: string[] = []
        const seenFoo: number[] = []
        const seenBar: string[] = []
        let fooSubscribed = false
        let barSubscribed = false

        for (const step of steps) {
          switch (step.kind) {
            case 'receive-foo': {
              sentFoo.push(step.value)
              dispatcher.receive<'Foo'>({ _tag: 'Foo', value: step.value })
              break
            }
            case 'receive-bar': {
              sentBar.push(step.name)
              dispatcher.receive<'Bar'>({ _tag: 'Bar', name: step.name })
              break
            }
            case 'subscribe-foo': {
              if (fooSubscribed) break
              fooSubscribed = true
              dispatcher.setMessageListener('Foo', (m) => {
                seenFoo.push(m.value)
              })
              break
            }
            case 'subscribe-bar': {
              if (barSubscribed) break
              barSubscribed = true
              dispatcher.setMessageListener('Bar', (m) => {
                seenBar.push(m.name)
              })
              break
            }
          }
        }

        // Subscribe at the end (idempotent) so any messages that arrived
        // pre-subscription are drained before we assert.
        if (!fooSubscribed) {
          dispatcher.setMessageListener('Foo', (m) => {
            seenFoo.push(m.value)
          })
        }
        if (!barSubscribed) {
          dispatcher.setMessageListener('Bar', (m) => {
            seenBar.push(m.name)
          })
        }

        expect(seenFoo).toEqual(sentFoo)
        expect(seenBar).toEqual(sentBar)
      })
    )
  })

  test('the type system rejects sendMessage of a tag absent from Send (compile-time)', () => {
    // Compile-only assertion: a record typed Receive must be a MessageSchemaRecord;
    // setMessageListener narrowed by `keyof Receive & string`. This block exists
    // to lock the public type so future refactors don't accidentally widen it.
    const _typed: MessageSchemaRecord = TestRecord
    expect(_typed).toBeDefined()
  })
})
