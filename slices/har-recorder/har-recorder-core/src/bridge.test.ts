import { Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { HarRecorderBridge, HarSaveFailed, HarSaved, SaveHar } from './bridge.ts'

/**
 * The wire strings this slice's TSDoc publishes, and which
 * `har-recorder-rust`'s serde mirror is pinned to by its own golden tests. They
 * are the contract, so they are asserted as text here rather than rebuilt from
 * the schemas — a renamed field fails this test on the TS side at the same time
 * as the Rust one.
 */
const SAVE_HAR_WIRE =
  '{"_tag":"SaveHar","fileName":"2026-09-13T14-02-11Z-portal.example.org.har","text":"{\\"log\\":{}}"}'
const HAR_SAVED_WIRE =
  '{"_tag":"HarSaved","fileName":"2026-09-13T14-02-11Z-portal.example.org.har","path":"/home/ada/.local/share/wildflower/saved_data/2026-09-13T14-02-11Z-portal.example.org.har"}'
const HAR_SAVE_FAILED_WIRE =
  '{"_tag":"HarSaveFailed","fileName":"../escape.har","message":"file name is not one safe path segment"}'

describe('HarRecorderBridge', () => {
  it('should declare SaveHar to the host and the two answers back', () => {
    // Assert — a tag must be unique across every listener on the shared
    // channel, so which side declares which is part of the contract.
    expect(Object.keys(HarRecorderBridge.WebToHost)).toEqual(['SaveHar'])
    expect(Object.keys(HarRecorderBridge.HostToWeb)).toEqual(['HarSaved', 'HarSaveFailed'])
    expect(HarRecorderBridge.name).toBe('HarRecorder')
  })

  it('should decode the documented SaveHar wire string', () => {
    // Act
    const message = Schema.decodeUnknownSync(SaveHar)(SAVE_HAR_WIRE)

    // Assert
    expect(message).toEqual({
      _tag: 'SaveHar',
      fileName: '2026-09-13T14-02-11Z-portal.example.org.har',
      text: '{"log":{}}',
    })
  })

  it('should decode the documented HarSaved wire string', () => {
    // Act
    const message = Schema.decodeUnknownSync(HarSaved)(HAR_SAVED_WIRE)

    // Assert
    expect(message.fileName).toBe('2026-09-13T14-02-11Z-portal.example.org.har')
    expect(message.path).toContain('saved_data')
  })

  it('should decode the documented HarSaveFailed wire string', () => {
    // Act
    const message = Schema.decodeUnknownSync(HarSaveFailed)(HAR_SAVE_FAILED_WIRE)

    // Assert
    expect(message.message).toBe('file name is not one safe path segment')
  })

  it('should refuse a SaveHar with an empty file name', () => {
    // Act / Assert — the host validates the name too, but a message that could
    // never name a file should not reach it.
    expect(() =>
      Schema.decodeUnknownSync(SaveHar)('{"_tag":"SaveHar","fileName":"","text":"{}"}')
    ).toThrow()
  })

  it('should accept an empty archive text, which is not the same as an absent one', () => {
    // Act
    const message = Schema.decodeUnknownSync(SaveHar)(
      '{"_tag":"SaveHar","fileName":"a.har","text":""}'
    )

    // Assert
    expect(message.text).toBe('')
    expect(() =>
      Schema.decodeUnknownSync(SaveHar)('{"_tag":"SaveHar","fileName":"a.har"}')
    ).toThrow()
  })
})
