import { Schema } from 'effect'
import { describe, expect, test } from 'vite-plus/test'
import * as Message from './message.ts'

const Ping = Schema.parseJson(Schema.TaggedStruct('Ping', { value: Schema.Number }))

describe('Message.stringifyMessage', () => {
  test('encodes a message via the schema record that owns its tag', () => {
    const record = { Ping }
    const wire = Message.stringifyMessage(record, { _tag: 'Ping', value: 7 })

    expect(JSON.parse(wire)).toEqual({ _tag: 'Ping', value: 7 })
  })

  test('throws synchronously with the offending tag when no schema owns it', () => {
    const record = { Ping }
    // `stringifyMessage` is the runtime tripwire for an unowned outbound
    // tag — the transport's outbound pump catches the resulting defect
    // and logs it, so the error message text matters for diagnosability.
    expect(() => Message.stringifyMessage(record, { _tag: 'Unknown' })).toThrow(
      'no schema for tag "Unknown"'
    )
  })
})
