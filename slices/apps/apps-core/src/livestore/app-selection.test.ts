import { Schema } from 'effect'
import { utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { events } from './app-selection.ts'

const { expectLeftToEqual, expectRightToEqual } = utilityExpectations(expect)

describe('appEnabledChanged event', () => {
  it('decodes a valid payload', () => {
    expectRightToEqual(
      Schema.decodeUnknownEither(events.appEnabledChanged.schema)({
        id: 'patient-browser',
        kind: 'bundled',
        enabled: false,
      }),
      { id: 'patient-browser', kind: 'bundled', enabled: false }
    )
  })

  it('rejects an unknown kind', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(events.appEnabledChanged.schema)({
        id: 'x',
        kind: 'mystery',
        enabled: true,
      }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })
})

describe('customAppAdded event', () => {
  it('decodes a valid payload', () => {
    const payload = {
      id: 'custom-abc',
      name: 'My App',
      url: 'https://example.com/launch',
      requiresTunnel: true,
    }
    expectRightToEqual(Schema.decodeUnknownEither(events.customAppAdded.schema)(payload), payload)
  })
})

describe('customAppUpdated event', () => {
  it('decodes a payload with only the id', () => {
    expectRightToEqual(Schema.decodeUnknownEither(events.customAppUpdated.schema)({ id: 'x' }), {
      id: 'x',
    })
  })

  it('decodes partial updates', () => {
    expectRightToEqual(
      Schema.decodeUnknownEither(events.customAppUpdated.schema)({
        id: 'x',
        name: 'Renamed',
      }),
      { id: 'x', name: 'Renamed' }
    )
  })
})

describe('customAppRemoved event', () => {
  it('decodes a valid payload', () => {
    expectRightToEqual(Schema.decodeUnknownEither(events.customAppRemoved.schema)({ id: 'x' }), {
      id: 'x',
    })
  })
})
