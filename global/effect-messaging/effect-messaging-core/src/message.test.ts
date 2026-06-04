import { Cause, Effect, Exit, Schema } from 'effect'
import { describe, expect, test } from 'vite-plus/test'
import * as Message from './message.ts'

const Ping = Schema.parseJson(Schema.TaggedStruct('Ping', { value: Schema.Number }))

describe('Message.stringifyMessage', () => {
  test('encodes a message via the schema record that owns its tag', () => {
    const record = { Ping }
    const wire = Effect.runSync(Message.stringifyMessage(record, { _tag: 'Ping', value: 7 }))

    expect(JSON.parse(wire)).toEqual({ _tag: 'Ping', value: 7 })
  })

  test('dies with the offending tag when no schema owns it', () => {
    const record = { Ping }
    // `stringifyMessage` is the runtime tripwire for an unowned outbound
    // tag: it `die`s (a defect) rather than failing, since the transport
    // rules out unowned tags before calling. The outbound pump's
    // `catchAllDefect` logs it, so the message text matters for diagnosis.
    const exit = Effect.runSyncExit(Message.stringifyMessage(record, { _tag: 'Unknown' }))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.isDie(exit.cause)).toBe(true)
      expect(Cause.pretty(exit.cause)).toContain('no schema for tag "Unknown"')
    }
  })
})
